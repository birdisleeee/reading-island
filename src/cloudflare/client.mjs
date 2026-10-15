// Browser-side transport for the accepted reading UI. No IndexedDB/local file store.
export function createReadingClient({ getToken = () => null, fetchImpl = globalThis.fetch.bind(globalThis), origin = globalThis.location?.origin }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('Invalid reading API origin');
  const id = value => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid reading identity');
    return value;
  };
  async function request(path, method = 'GET', body, binary = false, blob = false) {
    const token = await getToken();
    const response = await fetchImpl(new URL(`/api/reading/${path}`, base), {
      method, redirect: 'error', cache: 'no-store', credentials: 'same-origin',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) },
      ...(body !== undefined ? { body: binary ? body : JSON.stringify(body) } : {}),
    });
    if (response.ok && blob) return response.blob();
    const value = await response.json();
    if (!response.ok) {
      const publicErrors={storage_quota_exceeded:'存储额度不足，请到账户页申请扩容。',record_quota_exceeded:'书籍或议题已达上限，请到账户页申请扩容。',public_quota_unavailable:'公共服务额度不足或账号已暂停，请查看账户状态。',public_account_required:value.message||'请到公共服务账户页登录并等待审批。'};
      const message = publicErrors[value.error] || (response.status === 409
        ? '内容已更新，请刷新后重试。'
        : response.status === 401
          ? '请重新登录共读岛。'
          : response.status === 403
            ? '请使用读者身份进入共读岛。'
            : response.status === 503
              ? '共读岛云端暂时不可用，请稍后重试。'
              : '暂时无法保存或读取，请稍后重试。');
      throw Object.assign(new Error(message), { code: value.error, status: response.status });
    }
    return value;
  }
  const resource = value => {
    if (!['groups', 'books', 'documents', 'annotations', 'threads', 'messages'].includes(value)) throw new Error('Invalid reading resource');
    return value;
  };
  return Object.freeze({
    unread: () => request('unread'),
    readThread: (threadId, messageId) => request(`threads/${id(threadId)}/read`, 'POST', {message_id:id(messageId)}),
    list: (kind, query = {}) => request(`${resource(kind)}?${new URLSearchParams(query)}`),
    get: (kind, key) => request(`${resource(kind)}/${id(key)}`),
    createGroup: value => request('groups', 'POST', value),
    deleteGroup: value => request(`groups/${id(value.group_id)}?revision=${value.revision}`, 'DELETE'),
    createBook: value => request('books', 'POST', value),
    updateBook: value => request(`books/${id(value.book_id)}`, 'PATCH', value),
    createAnnotation: value => request('annotations', 'POST', value),
    createThread: value => request('threads', 'POST', value),
    sendMessage: value => request(`threads/${id(value.thread_id)}/messages`, 'POST', value),
    retryTurn: value => request(`threads/${id(value.thread_id)}/retry`, 'POST', { turn_id: id(value.turn_id) }),
    updateThread: value => request(`threads/${id(value.thread_id)}`, 'PATCH', value),
    readContext: thread => request(`threads/${id(thread.thread_id)}/context`),
    updateChapters: value => request(`documents/${id(value.document_id)}/chapters`, 'PATCH', value),
    uploadCover: (book, file) => request(`books/${id(book.book_id)}/cover?revision=${book.revision}`, 'PUT', file, true),
    visitChapter: (documentId, start) => request(`documents/${id(documentId)}/progress`, 'POST', {start}),
    readCover: book => request(`books/${id(book.book_id)}/cover`, 'GET', undefined, false, true),
    readOriginal: document => request(`documents/${id(document.document_id)}/original`, 'GET', undefined, false, true),
    readText: document => request(`documents/${id(document.document_id)}/text`, 'GET', undefined, false, true),
    uploadDocument: ({ book_id, document_id, file }) => request(`documents/${id(document_id)}?${new URLSearchParams({ book_id: id(book_id), filename: file.name })}`, 'PUT', file, true),
    readSource: (document, start = 0, limit = 2000) => request(`documents/${id(document.document_id)}/source?${new URLSearchParams({ book_id: id(document.book_id), version: document.version, sha: document.text_sha256, start, limit })}`),
  });
}
