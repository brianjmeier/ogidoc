// A session is a name: one the person gives, or one inferred from where they are. Its
// plan file is the store's business, never the person's.

// Lowercase letters, digits and dashes, so a name works in a path, a URL and a command.
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMMANDS = new Set(["list", "status", "wait", "stop", "install-skill"]);

// A name the person typed. `weekly.plan` still reads as `weekly`.
export function sessionName(raw: string): string {
  const name = raw.trim().replace(/\.plan$/, "");
  if (!NAME.test(name)) throw new Error(`"${raw}" can't name a session. Use lowercase letters, digits and dashes, like "weekly-review".`);
  if (COMMANDS.has(name)) throw new Error(`"${name}" is one of ogidoc's commands, so it can't name a session.`);
  return name;
}

// A name made from a folder's: "My App" becomes "my-app".
export const fromFolder = (folder: string): string =>
  folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "plan";

// Asks the person in the terminal; an empty answer takes the suggestion.
export type Ask = (question: string, suggestion: string) => Promise<string>;

// The session to open: the one named, the only one started here, or one the person names.
// Without a way to ask, several here is an error and none here takes the folder's name.
export async function sessionToOpen({ given, here, folder, ask }: { given?: string; here: string[]; folder: string; ask?: Ask }): Promise<string> {
  if (given) return sessionName(given);
  if (here.length === 1) return here[0];
  const answer = async (question: string, suggestion: string) => sessionName((await ask!(question, suggestion)).trim() || suggestion);
  if (here.length > 1) {
    if (!ask) throw new Error(`Several sessions were started here: ${here.join(", ")}. Name one: ogidoc <name>.`);
    return answer(`Which session? (${here.join(", ")})`, here[0]);
  }
  return ask ? answer("Name this session", fromFolder(folder)) : fromFolder(folder);
}
