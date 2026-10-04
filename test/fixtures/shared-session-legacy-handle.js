async function handle(message, sender) {
      const origin = senderOrigin(sender), value = scope(message.scope);
      const method = message.method;
      if (method === 'list') return list(value, typeof message.after === 'string' ? message.after : '');
      if (method === 'get') {
        const record = await readOne('sessions', [value.accountScopeId, part(message.id)]);
        return record && (!value.projectId || value.projectId === record.projectId)
          ? { ...record.record, sharedRevision: record.revision } : null;
      }
      if (method === 'migration-status') {
        const cleared = await readOne('migrations', [value.accountScopeId, '*']);
        return cleared?.clearedAt ? { complete: true, clearedAt: cleared.clearedAt }
          : await readOne('migrations', [value.accountScopeId, origin]) || { complete: false };
      }
      if (method === 'migration-complete') {
        ensureLock(message, value, sender);
        const db = await openDb(), tx = db.transaction('migrations', 'readwrite'), done = finished(tx);
        tx.objectStore('migrations').put({ ...value, origin, complete: true, at: Date.now() });
        await done; return { complete: true };
      }
      if (method === 'put' || method === 'import') {
        const result = await writeMany(message, value, method === 'import', origin, sender);
        if (result.length) await notify(value, message.clientId);
        return result;
      }
      if (method === 'delete' || method === 'clear-project' || method === 'clear-account') {
        if (method === 'clear-project') part(value.projectId);
        await erase(value, method === 'delete' ? part(message.id) : '', method === 'clear-account', message, sender);
        await notify(value, message.clientId); return true;
      }
      if (method === 'meta-read' || method === 'meta-write') {
        const key = metaKey(value);
        if (method === 'meta-read') return (await chromeApi.storage.local.get(key))[key] || {};
        const held = locks.get(keyFor('state', value));
        if (!held || held.token !== message.lockToken || held.tabId !== sender.tab.id)
          throw failure('storage_lock_lost', 'The shared persistence lock was lost.');
        await chromeApi.storage.local.set({ [key]: message.meta }); return message.meta;
      }
      throw failure('shared_store_method_invalid', 'Unsupported shared session operation.');
    }
