# Household's built-in skills

Skills Household gives every pet whose agent has a user skills directory. They are part of Household: mounted
read-only into each VM at `/opt/household/builtin-skills` and linked into the house's shared skills as
`household-<name>` at every VM start. Pets and the owner cannot edit them; change them here, in the repository.

The system prompt (`src/core/prompts.ts`) keep what an agent needs on every turn and every rule about
safety. A skill holds a way of doing something the agent recognises it is about to do. Calling details of one tool
belong in that tool's MCP description.
