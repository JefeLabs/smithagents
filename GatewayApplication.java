import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The Spring Boot entry point and "central nervous system" of the swarm (PRD §3).
 *
 * <p>Responsibilities this class will grow into (each is a later slice):
 * <ul>
 *   <li><b>Discord (JDA):</b> stream raw PCM audio to the voice channel and route
 *       transcriptions into the swarm.</li>
 *   <li><b>WebSocket server:</b> synchronize the Tauri thin clients (desktop + iOS).</li>
 *   <li><b>_embabel routing engine:</b> decide which persona handles each message
 *       (see {@link #routeToPersona}).</li>
 *   <li><b>mTLS validation:</b> reject any client lacking a valid device
 *       certificate (enforced at the servlet-container / ngrok boundary).</li>
 * </ul>
 *
 * <p><b>Flat-topology caveat (PRD §2):</b> this class sits in the <i>default
 * package</i> at the repo root. {@code @SpringBootApplication} therefore
 * component-scans the entire classpath — which is broad, and interacts with
 * Embabel's own {@code @Agent}/{@code @Action} scanning. Acceptable for now;
 * revisit if scan time or accidental bean pickup becomes a problem.
 */
@SpringBootApplication
public class GatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(GatewayApplication.class, args);
    }

    /** The three defined auditor personas (PRD §6). */
    public enum Persona {
        MANUEL,   // Architect — multi-tenant routing & infrastructure
        OCTAVIO,  // Security / Integration Auditor — API boundaries & page composition
        AURELIO   // UI Purist — atomic-design enforcement on view components
    }

    /** A message arriving from Discord, normalized for routing. */
    public record IncomingMessage(String author, String content, String channelId) {}

    // ─────────────────────────────────────────────────────────────────────────
    // YOUR FIRST CONTRIBUTION  (see README → "Your first contribution")
    //
    // This is the core of the _embabel routing engine: given an incoming Discord
    // message, decide which persona should handle it. There are several valid
    // strategies — pick the one that fits how your team talks in Discord:
    //
    //   • Explicit @mention  — "@Aurelio look at this component"  (precise, verbose)
    //   • Keyword / domain    — "component"/"style" → AURELIO, "payload"/"api" → OCTAVIO,
    //                           "tenant"/"routing" → MANUEL      (fast, brittle at edges)
    //   • LLM classification  — let Embabel classify intent      (flexible, adds latency/cost)
    //
    // Constraint: this runs on every inbound message, so favor a cheap default
    // and only escalate to an LLM when the cheap path is ambiguous. Decide what
    // happens when nothing matches (a default owner? ask for clarification?).
    // ─────────────────────────────────────────────────────────────────────────
    static Persona routeToPersona(IncomingMessage message) {
        // TODO(you): implement the routing decision described above (~5-10 lines).
        throw new UnsupportedOperationException(
                "routeToPersona not implemented — see README 'Your first contribution'");
    }
}
