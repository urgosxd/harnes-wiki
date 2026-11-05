# Agent definitions

Each `*.md` file here is a role the agent can be given. Development bind-mounts this
directory read-only to `/home/node/.agents/agents`; production bakes it into the image,
so a deployed agent scope stays versioned by the image tag.

Frontmatter between `---` lines is read as `key: value`. Only `name` and `description`
are used. Host pi-herdsman definitions also carry `tools`, `model` and `thinking`, and
this runtime honors none of them, so those keys are **ignored with a startup warning**
that names the file and the keys. The directory still loads, which is what makes a
bind-mounted pi-herdsman directory usable at all. The strictness applies to the
selection instead: `AGENT_DEFINITION=<name>` fails the boot for a definition that
carries them, and also for an unknown name, listing the names that were found.
