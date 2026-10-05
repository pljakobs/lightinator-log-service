"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

async function testDecoders(toolsDir) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "decoder-smoke-"));
  try {
    for (const [soc, arch, prefix, pc] of [
      ["esp8266", "Esp8266", "xtensa-lx106-elf", "0x40201000"],
      ["esp32", "Esp32", "xtensa-esp32-elf", "0x400d1000"],
      ["esp32c3", "Esp32", "riscv32-esp-elf", "0x40380000"],
    ]) {
      const source = path.join(temp, `${soc}.S`);
      const object = path.join(temp, `${soc}.o`);
      const elf = path.join(temp, `${soc}.elf`);
      await fs.writeFile(source, `.file 1 "${source}"\n.text\n.global _start\n.loc 1 5 0\n_start:\n  nop\n`);
      execFileSync(`${prefix}-as`, ["--gdwarf-2", "-o", object, source]);
      execFileSync(`${prefix}-ld`, [`-Ttext=${pc}`, "-e", "_start", "-o", elf, object]);
      if (soc === "esp8266") {
        await fs.writeFile(path.join(temp, `${soc}.map`), `  0x40201010 map_only_smoke_symbol\n`);
      }
      const dump = soc === "esp8266"
        ? `***** Fatal exception 28 (LoadProhibited)\npc=${pc} sp=0x3ffff000 excvaddr=0x00000000\nStack dump:\n3ffff000: 40201010 00000000 00000000 00000000\n\n`
        : `Guru Meditation Error: Core 0 panic\nCore 0 register dump:\n${soc === "esp32c3" ? "MEPC" : "PC"} : ${pc}  ${soc === "esp32c3" ? "MCAUSE" : "EXCCAUSE"} : 0x00000005\n\n`;
      const decoded = execFileSync("python3", [path.join(toolsDir, `decode-${arch === "Esp8266" ? "esp8266" : "esp32"}.py`), elf], {
        input: dump, encoding: "utf8", env: { ...process.env, SMING_ARCH: arch, SMING_SOC: soc },
      });
      assert.match(decoded, /_start/);
      assert.match(decoded, /Disassembly around/);
      assert.match(decoded, /Context in/);
      assert.match(decoded, /nop/);
      if (soc === "esp8266") assert.match(decoded, /map_only_smoke_symbol/);
      console.log(`Decoder smoke passed: ${soc}`);
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

testDecoders(process.argv[2] || "/app/tools").catch(error => { console.error(error); process.exitCode = 1; });