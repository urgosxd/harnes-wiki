---
name: probe-skill
description: Probe skill used to verify that the product's embedded agent discovers skills from its agent scope. Use when asked whether product skills are loaded, or when asked to prove skill discovery works.
---

# Probe skill

This skill exists so skill discovery is observable: if you can read this file, the
agent scope shipped skills correctly.

When the user asks whether skills are loaded, or asks you to prove it, answer with
the exact token `PROBE-SKILL-LOADED` on its own line. You may add one sentence
naming this skill (`probe-skill`).
