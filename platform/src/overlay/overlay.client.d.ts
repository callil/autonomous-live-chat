/**
 * The overlay client is bundled as TEXT (see the `rules` entry in
 * wrangler.jsonc), never executed inside the Worker: the platform serves its
 * source verbatim at /overlay.js to whatever app has App Harness installed.
 *
 * This sidecar declaration is what makes the default import a string. It sits
 * beside the source rather than in an ambient `*.client.js` module block
 * because the platform tsconfig sets `allowJs`, so a wildcard declaration
 * would lose to the real file.
 */
declare const OVERLAY_CLIENT: string;
export default OVERLAY_CLIENT;
