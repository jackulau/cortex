/**
 * Discord slash command definitions for Cortex.
 * These are registered with Discord via the register.ts script.
 */

/** Discord application command option types */
export const OptionType = {
  STRING: 3,
} as const;

/** Memory type choices for the /remember command */
const MEMORY_TYPE_CHOICES = [
  { name: "Fact", value: "fact" },
  { name: "Preference", value: "preference" },
  { name: "Event", value: "event" },
  { name: "Note", value: "note" },
];

/** All slash commands exposed by Cortex */
export const COMMANDS = [
  {
    name: "ask",
    description: "Ask Cortex a question",
    options: [
      {
        name: "question",
        type: OptionType.STRING,
        description: "The question to ask Cortex",
        required: true,
      },
    ],
  },
  {
    name: "remember",
    description: "Save something to Cortex's memory",
    options: [
      {
        name: "content",
        type: OptionType.STRING,
        description: "The content to remember",
        required: true,
      },
      {
        name: "type",
        type: OptionType.STRING,
        description: "Type of memory",
        required: false,
        choices: MEMORY_TYPE_CHOICES,
      },
    ],
  },
  {
    name: "recall",
    description: "Search Cortex's memory",
    options: [
      {
        name: "query",
        type: OptionType.STRING,
        description: "What to search for",
        required: true,
      },
    ],
  },
  {
    name: "research",
    description: "Research a URL",
    options: [
      {
        name: "url",
        type: OptionType.STRING,
        description: "The URL to research",
        required: true,
      },
    ],
  },
  {
    name: "digest",
    description: "Get your latest digest",
  },
] as const;

/** Command names for type-safe routing */
export type CommandName = (typeof COMMANDS)[number]["name"];
