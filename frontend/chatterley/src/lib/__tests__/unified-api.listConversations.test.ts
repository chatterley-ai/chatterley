import unifiedApiClient from '../../lib/unified-api';

describe('unified-api listConversations session scoping', () => {
  const originalGetStorageItem = unifiedApiClient.getStorageItem.bind(unifiedApiClient as unknown);

  afterEach(() => {
    // Restore real method after each test
    (unifiedApiClient as Record<string, unknown>).getStorageItem = originalGetStorageItem;
  });

  it('returns only conversations for the provided sessionId', async () => {
    const sessionId = 'session-123';
    const key = `conversations_${sessionId}`;

    const sample = [
      { id: 'c1', lastModified: '2025-01-01T10:00:00Z' },
      { id: 'c2', lastModified: '2025-01-02T10:00:00Z' },
    ];

    const spy = jest
      .spyOn(unifiedApiClient as Record<string, unknown>, 'getStorageItem')
      .mockImplementation(((k: string, def: unknown) => {
        // The following implementation is specifically for the test
        if (k === key) return sample;
        // If the implementation tries to read other session keys, surface it
        if (k.startsWith('conversations_') && k !== key) {
          throw new Error(`Attempted to read unexpected key: ${k}`);
        }
        return def;
      }) as unknown);

    const res = await unifiedApiClient.listConversations(sessionId);
    expect(res.success).toBe(true);
    expect(res.data?.conversations.map((c: Record<string, unknown>) => c.id)).toEqual(['c2', 'c1']); // sorted by lastModified desc
    expect(spy).toHaveBeenCalledWith(key, []);
  });

  it('handles missing key by returning empty list', async () => {
    const sessionId = 'empty-session';
    const key = `conversations_${sessionId}`;

    const spy = jest
      .spyOn(unifiedApiClient as Record<string, unknown>, 'getStorageItem')
      .mockResolvedValueOnce([]);

    const res = await unifiedApiClient.listConversations(sessionId);
    expect(res.success).toBe(true);
    expect(res.data?.conversations).toEqual([]);
    expect(spy).toHaveBeenCalledWith(key, []);
  });
});

