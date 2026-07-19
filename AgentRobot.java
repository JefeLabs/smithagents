import java.awt.Robot;
import java.awt.Toolkit;
import java.awt.datatransfer.StringSelection;
import java.awt.event.KeyEvent;

/**
 * Native AWT execution bridge for OS-level keystroke injection (PRD §2, §4).
 *
 * <p>When the gateway generates a {@code PRD-*.md} blueprint from a Discord
 * conversation, this bridge drives the integrated terminal — typing commands and
 * pressing Enter — to spin up the per-branch Docker sandbox.
 *
 * <p><b>Platform note (macOS):</b> {@link java.awt.Robot} requires a non-headless
 * JVM and, on macOS, the host process must be granted <i>Accessibility</i>
 * permission (System Settings → Privacy &amp; Security → Accessibility). Without
 * it, injected events are silently dropped.
 *
 * <p>Flat topology: this class lives in the default package at the repo root by
 * design (see PRD §2). See README for the trade-offs that entails.
 */
public final class AgentRobot {

    private static final boolean IS_MAC =
            System.getProperty("os.name", "").toLowerCase().contains("mac");

    private final Robot robot;

    public AgentRobot() throws java.awt.AWTException {
        this.robot = new Robot();
        this.robot.setAutoDelay(20);
    }

    /**
     * Types arbitrary text via the system clipboard + paste. Clipboard paste is
     * used instead of per-character {@code keyPress} mapping because it is
     * layout-independent and handles Unicode, which raw {@link KeyEvent} codes
     * do not.
     */
    public void typeText(String text) {
        Toolkit.getDefaultToolkit()
                .getSystemClipboard()
                .setContents(new StringSelection(text), null);

        int modifier = IS_MAC ? KeyEvent.VK_META : KeyEvent.VK_CONTROL;
        robot.keyPress(modifier);
        robot.keyPress(KeyEvent.VK_V);
        robot.keyRelease(KeyEvent.VK_V);
        robot.keyRelease(modifier);
    }

    /** Presses Enter to submit whatever is currently in the terminal input. */
    public void pressEnter() {
        robot.keyPress(KeyEvent.VK_ENTER);
        robot.keyRelease(KeyEvent.VK_ENTER);
    }
}
