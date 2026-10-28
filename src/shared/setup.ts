// What the person hands to their own AI when the recording helper is missing or broken. The repo path and build id are
// baked in by build.mjs, so the prompt names the real install guide on this machine.
declare const __R2C_REPO__: string;
declare const __R2C_BUILD__: string;

export const REPO_PATH = typeof __R2C_REPO__ === "string" ? __R2C_REPO__ : "";
export const BUILD_ID = typeof __R2C_BUILD__ === "string" ? __R2C_BUILD__ : "dev";

export const NOT_SET_UP = "Not set up yet — give this to your AI";
export const HELPER_PROBLEM = "Recordings folder problem — give this to your AI";

export function installGuide(repo = REPO_PATH): string {
  return repo ? `${repo}/INSTALL-FOR-AI.md` : "INSTALL-FOR-AI.md in the record2context repository";
}

export function setupPrompt(repo = REPO_PATH): string {
  return `Set up record2context's recording helper on this computer: follow ${installGuide(repo)} from start to finish, including its verify loop.`;
}

export function problemPrompt(error: string, repo = REPO_PATH): string {
  return `record2context's recording helper reports a problem: "${error}". Fix it by following ${installGuide(repo)} (re-run the install and its verify loop).`;
}
