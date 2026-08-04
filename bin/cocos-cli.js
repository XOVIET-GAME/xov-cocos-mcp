#!/usr/bin/env node
'use strict';

const { main } = require('./funplay-cocos-mcp.js');

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(`[Cocos CLI] ${error.message}`);
  process.exitCode = 1;
});
