import { readJsonFile, writeJsonAtomic } from "./files";
import { statePath } from "./paths";
import { type State, StateSchema } from "./schemas";

export async function loadState(env: NodeJS.ProcessEnv = process.env): Promise<State> {
  return StateSchema.parse((await readJsonFile(statePath(env))) ?? {});
}

export async function saveState(state: State, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await writeJsonAtomic(statePath(env), state);
}
