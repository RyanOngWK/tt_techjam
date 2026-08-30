import { rm } from "node:fs/promises";

/**
 * Removes temporary test directories after each test. Runs execute
 * fire-and-forget, so a terminal run status can be observed before the last
 * store writes (RUN_COMPLETED / ALERT / checkpoint copies) have landed.
 * Retry transient ENOTEMPTY/EBUSY instead of racing those writes.
 */
export async function removeTemporaryDirectories(directories: string[]): Promise<void> {
  const targets = directories.splice(0);
  await Promise.all(
    targets.map(async (directory) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          await rm(directory, { recursive: true, force: true });
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EAGAIN") {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      throw new Error("Timed out removing temporary directory " + directory);
    }),
  );
}
