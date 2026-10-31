#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

#ifndef NBS_NOTIFICATION_CENTER
#define NBS_NOTIFICATION_CENTER [UNUserNotificationCenter currentNotificationCenter]
#endif
#ifndef NBS_NOTIFICATION_BUNDLE_ID
#define NBS_NOTIFICATION_BUNDLE_ID [[NSBundle mainBundle] bundleIdentifier]
#endif

typedef void (*NBSNotificationOpenTarget)(int64_t);

@interface NBSWatchdogNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, assign) NBSNotificationOpenTarget openTarget;
@end

@implementation NBSWatchdogNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
      willPresentNotification:(UNNotification *)notification
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    // macOS suppresses foreground banners unless the delegate explicitly presents them.
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
 didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completionHandler {
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
        id value = response.notification.request.content.userInfo[@"watchdogMatchId"];
        if ([value isKindOfClass:[NSNumber class]] && [value longLongValue] > 0 && self.openTarget) {
            self.openTarget([value longLongValue]);
        }
    }
    completionHandler();
}
@end

// Keep the delegate alive: UNUserNotificationCenter holds only a weak reference.
static NBSWatchdogNotificationDelegate *notificationDelegate;

void nbs_notification_setup(NBSNotificationOpenTarget openTarget) {
    if (!NBS_NOTIFICATION_BUNDLE_ID) return;
    notificationDelegate = [NBSWatchdogNotificationDelegate new];
    notificationDelegate.openTarget = openTarget;
    NBS_NOTIFICATION_CENTER.delegate = notificationDelegate;
}

// Called on a Rust worker thread; never block the main AppKit event loop.
int nbs_notification_permission(bool request) {
    @autoreleasepool {
        if (!NBS_NOTIFICATION_BUNDLE_ID) return -1;
        UNUserNotificationCenter *center = NBS_NOTIFICATION_CENTER;
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block int result = -1;
        if (request) {
            [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
                completionHandler:^(BOOL granted, NSError *error) {
                    result = error ? -1 : (granted ? 2 : 1);
                    dispatch_semaphore_signal(done);
                }];
        } else {
            [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
                switch (settings.authorizationStatus) {
                    case UNAuthorizationStatusAuthorized:
                    case UNAuthorizationStatusProvisional: result = 2; break;
                    case UNAuthorizationStatusDenied: result = 1; break;
                    default: result = 0; break;
                }
                dispatch_semaphore_signal(done);
            }];
        }
        // Explicit permission dialogs can remain open while the user decides.
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (request ? 120 : 5) * NSEC_PER_SEC)) != 0) return -1;
        return result;
    }
}

// Called on the sidecar monitor thread. A successful return confirms that macOS
// accepted the request; Focus and the user's banner settings still control display.
bool nbs_notification_send(const char *title, const char *body, int64_t matchId,
                           char *errorBuffer, size_t errorBufferSize) {
    @autoreleasepool {
        NSString *failure = nil;
        if (!NBS_NOTIFICATION_BUNDLE_ID) failure = @"Notifications require the bundled macOS app";
        else if (matchId <= 0 || !title || !body) failure = @"Invalid Watchdog notification";
        if (failure) {
            if (errorBufferSize) snprintf(errorBuffer, errorBufferSize, "%s", failure.UTF8String);
            return false;
        }
        UNMutableNotificationContent *content = [UNMutableNotificationContent new];
        content.title = [NSString stringWithUTF8String:title];
        content.body = [NSString stringWithUTF8String:body];
        content.sound = UNNotificationSound.defaultSound;
        content.userInfo = @{ @"watchdogMatchId": @(matchId) };
        NSString *identifier = [NSString stringWithFormat:@"watchdog-%lld", (long long)matchId];
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier content:content trigger:nil];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block NSString *deliveryError = nil;
        [NBS_NOTIFICATION_CENTER addNotificationRequest:request withCompletionHandler:^(NSError *error) {
            deliveryError = error.localizedDescription;
            dispatch_semaphore_signal(done);
        }];
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
            failure = @"Timed out waiting for macOS to accept the notification";
        } else {
            failure = deliveryError;
        }
        // Never let an asynchronous completion access the caller's buffer after timeout.
        if (failure && errorBufferSize) snprintf(errorBuffer, errorBufferSize, "%s", failure.UTF8String);
        return failure == nil;
    }
}
