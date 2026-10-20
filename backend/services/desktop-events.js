export function sendDesktopNotification(notification, { desktop = process.env.DESKTOP_PARENT_WATCHDOG === '1', output = process.stdout } = {}) {
    if (!desktop) return;
    return new Promise((resolve, reject) => {
        const onError = error => reject(error);
        output.once?.('error', onError);
        try {
            output.write(`NBS_DESKTOP_EVENT ${JSON.stringify({ type: 'watchdog.notification', ...notification })}\n`, error => {
                if (error) reject(error); // Keep the listener until the stream emits its error.
                else { output.off?.('error', onError); resolve(); }
            });
        } catch (error) { output.off?.('error', onError); reject(error); }
    });
}
