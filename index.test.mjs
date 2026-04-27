import test from 'node:test';
import assert from 'node:assert';
import contextPrunePlugin from './index.js';

test('gsd-context-prune', async (t) => {
  const events = {};
  const appendedEntries = [];
  const notifications = [];
  const tools = [];
  const commands = [];
  
  const mockPi = {
    on: (eventName, handler) => {
      events[eventName] = handler;
    },
    appendEntry: (customType, data) => {
      appendedEntries.push({ customType, data });
    },
    registerTool: (tool) => {
      tools.push(tool);
    },
    registerCommand: (name, options) => {
      commands.push({ name, options });
    }
  };

  contextPrunePlugin(mockPi);

  await t.test('registers all required events, tools, and commands', () => {
    assert.ok(events['session_start'], 'should register session_start');
    assert.ok(events['context'], 'should register context');
    assert.ok(events['turn_end'], 'should register turn_end');
    
    assert.strictEqual(tools.length, 1, 'should register 1 tool');
    assert.strictEqual(tools[0].name, 'context_prune', 'tool should be context_prune');
    
    assert.strictEqual(commands.length, 1, 'should register 1 command');
    assert.strictEqual(commands[0].name, 'pruner', 'command should be pruner');
  });

  await t.test('projects primary summaries and collapses context', () => {
    // Mock the session start to load previous summaries
    events['session_start']({}, {
      sessionManager: {
        getBranch: () => [
          {
            type: 'custom',
            customType: 'context-prune-primary-data',
            data: {
              toolCallIds: ['call1', 'call2'],
              latestId: 'call2',
              summaryText: 'Tested summary text'
            }
          }
        ]
      }
    });

    const mockMessages = [
      { role: 'user', content: 'test user message' },
      { role: 'toolResult', toolCallId: 'call1', content: 'huge raw result 1' },
      { role: 'toolResult', toolCallId: 'call2', content: 'huge raw result 2' },
      { role: 'toolResult', toolCallId: 'call3', content: 'unpruned result 3' }
    ];

    const result = events['context']({ messages: mockMessages });

    assert.strictEqual(result.messages.length, 3, 'should replace 2 tool results with 1 summary');
    assert.strictEqual(result.messages[0].role, 'user', 'first message unchanged');
    
    const summaryMsg = result.messages[1];
    assert.strictEqual(summaryMsg.role, 'custom', 'should be custom message');
    assert.strictEqual(summaryMsg.customType, 'context-prune-primary', 'custom type matched');
    assert.ok(summaryMsg.content.includes('Tested summary text'), 'content matches summary');
    
    assert.strictEqual(result.messages[2].toolCallId, 'call3', 'unpruned result remains');
  });

  await t.test('does not trigger global summary on aborted or error stops', () => {
    let triggered = false;
    events['session_start']({}, {});

    // Overwrite the global summary function internally or mock it 
    // Here we just make sure we don't crash and don't change state
    events['turn_end']({
      message: { stopReason: 'error' }
    }, {
      getContextUsage: () => ({ contextWindow: 300, totalTokens: 250 }) // > 2/3
    });
    
    // State should remain un-triggered since it aborted/errored
    // We can verify this implicitly by lack of notifications, but easier to just check it runs
    assert.strictEqual(appendedEntries.length, 0, 'should not append global summary data');
  });

  await t.test('triggers global summary when usage exceeds 2/3 threshold', async () => {
    let triggered = false;
    let globalSummaryCalled = false;
    
    // We mock getCompleteFn indirectly by watching for UI notifications or appended entries
    // Since it's async we can mock ctx.modelRegistry etc
    
    events['session_start']({}, {});
    
    events['context']({ messages: [{ role: 'user', content: 'hello' }] }); // Set lastContextMessages
    
    const mockCtx = {
      getContextUsage: () => ({ contextWindow: 300, totalTokens: 250 }), // > 2/3
      ui: { notify: (msg) => { if (msg.includes('高级精简')) globalSummaryCalled = true; } },
      modelRegistry: { getApiKey: async () => 'test_key' },
      model: { headers: {} }
    };
    
    // We'll catch the unhandled promise rejection if import fails, but 
    // the initial sync check passes. The notify shows it entered the function.
    events['turn_end']({ message: { stopReason: 'stop' } }, mockCtx);
    
    assert.ok(globalSummaryCalled, 'should trigger global summary logic');
  });
});
