import { parseEnv } from "../src/lib/env";

const result = parseEnv(process.env);
if (!result.success) {
  const detail = result.error.issues
    .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  console.error(`Environment is not safe to start:\n${detail}`);
  process.exit(1);
}
console.log("Environment check passed. No secret values were printed.");
