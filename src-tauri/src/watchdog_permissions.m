#include <stdbool.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

// Called on a Rust worker thread; never block the main AppKit event loop.
int nbs_notification_permission(bool request) {
    @autoreleasepool {
        if (![[NSBundle mainBundle] bundleIdentifier]) return -1;
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
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
