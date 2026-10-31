#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <assert.h>
#include <string.h>

@interface TestNotificationSettings : NSObject
@property(nonatomic) UNAuthorizationStatus authorizationStatus;
@end
@implementation TestNotificationSettings
@end

@interface TestNotificationCenter : NSObject
@property(nonatomic, weak) id<UNUserNotificationCenterDelegate> delegate;
@property(nonatomic, strong) UNNotificationRequest *lastRequest;
@property(nonatomic, strong) NSError *deliveryError;
@property(nonatomic) UNAuthorizationStatus authorizationStatus;
@property(nonatomic) BOOL grantRequest;
@property(nonatomic) NSInteger permissionRequests;
@end
@implementation TestNotificationCenter
- (void)addNotificationRequest:(UNNotificationRequest *)request withCompletionHandler:(void (^)(NSError *))handler {
    self.lastRequest = request;
    NSError *error = self.deliveryError;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{ handler(error); });
}
- (void)getNotificationSettingsWithCompletionHandler:(void (^)(UNNotificationSettings *))handler {
    TestNotificationSettings *settings = [TestNotificationSettings new];
    settings.authorizationStatus = self.authorizationStatus;
    handler((UNNotificationSettings *)settings);
}
- (void)requestAuthorizationWithOptions:(UNAuthorizationOptions)options completionHandler:(void (^)(BOOL, NSError *))handler {
    assert(options & UNAuthorizationOptionAlert);
    self.permissionRequests++;
    handler(self.grantRequest, nil);
}
@end

@interface TestDeliveredNotification : NSObject
@property(nonatomic, strong) UNNotificationRequest *request;
@end
@implementation TestDeliveredNotification
@end
@interface TestNotificationResponse : NSObject
@property(nonatomic, copy) NSString *actionIdentifier;
@property(nonatomic, strong) TestDeliveredNotification *notification;
@end
@implementation TestNotificationResponse
@end

// Exercise the production bridge without requesting permissions or posting real
// notifications. Only the OS boundary is replaced; request contents and delegate
// behavior use the real UserNotifications types and implementation.
static TestNotificationCenter *testCenter;
static NSString *testBundleID = @"test.watchdog.fixture";
#define NBS_NOTIFICATION_CENTER ((UNUserNotificationCenter *)testCenter)
#define NBS_NOTIFICATION_BUNDLE_ID testBundleID
#import "../src/watchdog_permissions.m"

static int64_t openedTarget;
static void openTarget(int64_t id) { openedTarget = id; }

int main(void) {
    @autoreleasepool {
        testCenter = [TestNotificationCenter new];
        nbs_notification_setup(openTarget);
        assert(testCenter.delegate != nil);
        __block UNNotificationPresentationOptions presentation = 0;
        [testCenter.delegate userNotificationCenter:(UNUserNotificationCenter *)testCenter willPresentNotification:nil
            withCompletionHandler:^(UNNotificationPresentationOptions options) { presentation = options; }];
        assert(presentation & UNNotificationPresentationOptionBanner);
        assert(presentation & UNNotificationPresentationOptionList);
        assert(presentation & UNNotificationPresentationOptionSound);

        char error[128] = {0};
        assert(nbs_notification_send("Watchdog: Nachrichten", "Grüße (+2 more matches)", 42, error, sizeof(error)));
        UNNotificationRequest *request = testCenter.lastRequest;
        assert([request.identifier isEqualToString:@"watchdog-42"]);
        assert([request.content.title isEqualToString:@"Watchdog: Nachrichten"]);
        assert([request.content.body isEqualToString:@"Grüße (+2 more matches)"]);
        assert([request.content.userInfo[@"watchdogMatchId"] isEqual:@42]);
        assert(request.content.sound != nil && request.trigger == nil);

        testCenter.deliveryError = [NSError errorWithDomain:@"fixture" code:1 userInfo:@{NSLocalizedDescriptionKey: @"macOS rejected delivery"}];
        assert(!nbs_notification_send("Watchdog", "Article", 43, error, sizeof(error)));
        assert(strstr(error, "macOS rejected delivery") != NULL);
        testCenter.deliveryError = nil;
        assert(!nbs_notification_send("Watchdog", "Article", 0, error, sizeof(error)));
        assert(strstr(error, "Invalid") != NULL);

        for (NSNumber *status in @[@(UNAuthorizationStatusNotDetermined), @(UNAuthorizationStatusDenied), @(UNAuthorizationStatusAuthorized), @(UNAuthorizationStatusProvisional)]) {
            testCenter.authorizationStatus = status.integerValue;
            int expected = status.integerValue == UNAuthorizationStatusNotDetermined ? 0 : status.integerValue == UNAuthorizationStatusDenied ? 1 : 2;
            assert(nbs_notification_permission(false) == expected);
        }
        assert(testCenter.permissionRequests == 0);
        testCenter.grantRequest = YES;
        assert(nbs_notification_permission(true) == 2);
        testCenter.grantRequest = NO;
        assert(nbs_notification_permission(true) == 1);
        assert(testCenter.permissionRequests == 2);

        TestNotificationResponse *response = [TestNotificationResponse new];
        response.notification = [TestDeliveredNotification new];
        response.actionIdentifier = UNNotificationDefaultActionIdentifier;
        response.notification.request = request;
        __block NSInteger completed = 0;
        [testCenter.delegate userNotificationCenter:(UNUserNotificationCenter *)testCenter
            didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:^{ completed++; }];
        assert(openedTarget == 42 && completed == 1);
        openedTarget = 0;
        response.actionIdentifier = UNNotificationDismissActionIdentifier;
        [testCenter.delegate userNotificationCenter:(UNUserNotificationCenter *)testCenter
            didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:^{ completed++; }];
        assert(openedTarget == 0 && completed == 2);
        response.actionIdentifier = UNNotificationDefaultActionIdentifier;
        for (id target in @[@0, @(-1), @"42"]) {
            UNMutableNotificationContent *content = [UNMutableNotificationContent new];
            content.userInfo = @{ @"watchdogMatchId": target };
            response.notification.request = [UNNotificationRequest requestWithIdentifier:@"invalid" content:content trigger:nil];
            [testCenter.delegate userNotificationCenter:(UNUserNotificationCenter *)testCenter
                didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:^{ completed++; }];
            assert(openedTarget == 0);
        }
        assert(completed == 5);
        testBundleID = nil;
        assert(nbs_notification_permission(false) == -1);
        assert(!nbs_notification_send("Watchdog", "Article", 44, error, sizeof(error)));
        assert(strstr(error, "bundled macOS app") != NULL);
        puts("Watchdog native bridge fixture passed: foreground presentation, OS enqueue success/error, permissions and tap routing.");
    }
    return 0;
}
