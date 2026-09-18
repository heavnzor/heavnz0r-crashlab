// Replace the body with your agent runtime, or keep this as a controller test.
// The callTool adapter routes every effect into CrashLab's simulated world.
export default async function agent({ callTool, signal }) {
  const { approved } = await callTool("crashlab_context", {});
  if (!approved) return { declined: true };
  const operation = {
    requestId: "release-42",
    title: "Publish the reviewed change",
    idempotencyKey: "release-42:v1",
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      return await callTool("create_issue", operation);
    } catch (error) {
      if (error.code !== "TIMEOUT" || attempt === 2) throw error;
    }
  }
}
