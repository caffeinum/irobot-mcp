#!/usr/bin/env node
import { serve } from "../src/mcp.js";
serve().catch((err) => {
  console.error(`irobot-mcp failed to start: ${err.message}`);
  process.exit(1);
});
