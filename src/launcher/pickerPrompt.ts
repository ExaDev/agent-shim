import type { PromptsPort } from "../configure";
import type { IdentityPickerPort } from "./ports";

/**
 * The identity picker over a single-select prompt: each entry is an option, the request's initial entry is where the cursor starts, and a cancel (Ctrl-C) is reported as a cancel, not an error. The real prompt waits for the person with no timeout.
 */
export function promptsIdentityPicker(prompts: PromptsPort): IdentityPickerPort {
  return {
    pick: async (request) => {
      const answer = await prompts.select({
        message: request.message,
        options: request.entries.map((entry) => ({ value: entry.value, label: entry.label })),
        ...(request.initial === undefined ? {} : { initialValue: request.initial }),
      });
      return prompts.isCancel(answer) ? { kind: "cancelled" } : { kind: "picked", value: answer };
    },
  };
}
