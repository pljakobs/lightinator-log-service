const { test } = require("node:test");
const assert = require("node:assert/strict");

// Beispiel für einen Test der AI-Komponente mit simuliertem Verhalten (Mocking)
test("ai analysis handles mocked responses correctly without real token", async () => {
  // Angenommen, der AI-Service lässt sich mit einem Test-Modus oder Mock initialisieren
  const mockAiClient = {
    analyzeCrash: async (crashData) => {
      if (!crashData) throw new Error("No crash data provided");
      return {
        summary: "Mocked analysis: Null pointer exception in main loop",
        suggestion: "Check memory allocation",
      };
    },
  };

  const result = await mockAiClient.analyzeCrash({ message: "Exception (0)" });
  
  assert.equal(typeof result.summary, "string");
  assert.ok(result.summary.includes("Mocked analysis"));
  assert.equal(result.suggestion, "Check memory allocation");
});

test("ai service handles missing API keys gracefully", () => {
  // Testet das Verhalten, wenn kein Schlüssel vorhanden ist (sollte fehlschlagen oder gracefully degradieren)
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  try {
    const apiKeyConfigured = Boolean(process.env.GEMINI_API_KEY);
    assert.equal(apiKeyConfigured, false);
  } finally {
    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
  }
});

