/**
 * Discord slash command registration script.
 * Registers all Cortex commands with the Discord API.
 *
 * Usage: npx tsx src/discord/register.ts
 *
 * Required environment variables:
 *   DISCORD_APP_ID    - Discord application ID
 *   DISCORD_BOT_TOKEN - Discord bot token
 */

// Declare process for Node.js runtime (this script runs via npx tsx, not in Workers)
declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

import { COMMANDS } from "./commands";

const DISCORD_API_BASE = "https://discord.com/api/v10";

async function registerCommands(): Promise<void> {
  const appId = process.env.DISCORD_APP_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  if (!appId) {
    console.error("Error: DISCORD_APP_ID environment variable is required");
    process.exit(1);
  }

  if (!botToken) {
    console.error("Error: DISCORD_BOT_TOKEN environment variable is required");
    process.exit(1);
  }

  const url = `${DISCORD_API_BASE}/applications/${appId}/commands`;

  console.log(`Registering ${COMMANDS.length} commands...`);
  console.log(
    `Commands: ${COMMANDS.map((c) => `/${c.name}`).join(", ")}`
  );

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${botToken}`,
    },
    body: JSON.stringify(COMMANDS),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Failed to register commands (${response.status}): ${error}`);
    process.exit(1);
  }

  const data = await response.json();
  console.log(
    `Successfully registered ${(data as any[]).length} commands!`
  );
  for (const cmd of data as any[]) {
    console.log(`  /${cmd.name} (id: ${cmd.id})`);
  }
}

registerCommands().catch((error) => {
  console.error("Registration failed:", error);
  process.exit(1);
});
