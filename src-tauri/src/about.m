#import <AppKit/AppKit.h>

@interface NBSAboutPanel : NSPanel
@end

@implementation NBSAboutPanel
- (void)openWebsite:(id)sender {
    [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:@"https://oliverjessner.at"]];
}

- (void)cancelOperation:(id)sender {
    [self close];
}
@end

static NSTextField *aboutLabel(NSString *text, NSFont *font, NSColor *color) {
    NSTextField *label = [NSTextField labelWithString:text];
    label.font = font;
    label.textColor = color;
    label.alignment = NSTextAlignmentCenter;
    return label;
}

// Retain and reuse the panel after closing it; repeated menu actions focus it.
static NBSAboutPanel *aboutPanel;

void nbs_show_about(const char *name, const char *version, const unsigned char *icon, size_t iconLength) {
    NSCAssert([NSThread isMainThread], @"About must open on the AppKit thread");
    if (!aboutPanel) {
        NSString *appName = [NSString stringWithUTF8String:name];
        aboutPanel = [[NBSAboutPanel alloc]
            initWithContentRect:NSMakeRect(0, 0, 1, 1)
            styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable)
            backing:NSBackingStoreBuffered defer:NO];
        aboutPanel.title = [@"About " stringByAppendingString:appName];
        aboutPanel.releasedWhenClosed = NO;
        aboutPanel.hidesOnDeactivate = NO;
        aboutPanel.backgroundColor = NSColor.windowBackgroundColor;

        NSImageView *logo = [NSImageView new];
        logo.image = [[NSImage alloc] initWithData:[NSData dataWithBytes:icon length:iconLength]];
        logo.imageScaling = NSImageScaleProportionallyUpOrDown;
        logo.translatesAutoresizingMaskIntoConstraints = NO;
        [NSLayoutConstraint activateConstraints:@[
            [logo.widthAnchor constraintEqualToConstant:52],
            [logo.heightAnchor constraintEqualToConstant:52],
        ]];
        [logo setAccessibilityLabel:[appName stringByAppendingString:@" icon"]];

        NSFont *font = [NSFont systemFontOfSize:12];
        NSTextField *title = aboutLabel(appName, [NSFont boldSystemFontOfSize:16], NSColor.labelColor);
        NSTextField *appVersion = aboutLabel(
            [@"Version " stringByAppendingString:[NSString stringWithUTF8String:version]],
            font, NSColor.secondaryLabelColor);
        NSTextField *copyright = aboutLabel(@"Copyright © 2026 Oliver Jessner", font, NSColor.secondaryLabelColor);
        NSTextField *license = aboutLabel(@"MIT License", font, NSColor.secondaryLabelColor);

        NSButton *website = [NSButton buttonWithTitle:@"oliverjessner.at"
            target:aboutPanel action:@selector(openWebsite:)];
        website.bordered = NO;
        website.font = font;
        website.attributedTitle = [[NSAttributedString alloc] initWithString:website.title attributes:@{
            NSFontAttributeName: font,
            NSForegroundColorAttributeName: NSColor.linkColor,
            NSUnderlineStyleAttributeName: @(NSUnderlineStyleSingle),
        }];
        [website setAccessibilityRole:NSAccessibilityLinkRole];

        NSStackView *stack = [NSStackView stackViewWithViews:@[logo, title, appVersion, copyright, license, website]];
        stack.orientation = NSUserInterfaceLayoutOrientationVertical;
        stack.distribution = NSStackViewDistributionFill;
        stack.alignment = NSLayoutAttributeCenterX;
        stack.spacing = 8;
        stack.edgeInsets = NSEdgeInsetsMake(24, 32, 24, 32);
        [stack setCustomSpacing:12 afterView:logo];
        [stack setCustomSpacing:16 afterView:appVersion];

        // Intrinsic text sizes and padding determine the window, without a scroll view.
        NSSize contentSize = stack.fittingSize;
        aboutPanel.contentView = stack;
        [aboutPanel setContentSize:contentSize];
        [aboutPanel center];
    }
    [aboutPanel makeKeyAndOrderFront:nil];
}
