import { identity, ReadingError, requireValue, readBody, readJson } from './validation.mjs';
import { dispatchReadingTurn, readVerifiedGatewayJson, sourcePrincipal } from './ai.mjs';

const reply = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const resources = { groups: 'group', books: 'book', documents: 'document', annotations: 'annotation', threads: 'thread', messages: 'message' };

// Principal is resolved by server authentication, never by client owner_id.
export async function handleReadingApi(request, env, principal) {
  try {
    requireValue(principal, 'unauthorized', 401);
    requireValue(['reader','assistant'].includes(principal.role), 'forbidden', 403);
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    requireValue((!origin || origin === url.origin) && request.headers.get('sec-fetch-site') !== 'cross-site', 'cross_origin_forbidden', 403);
    requireValue(env.READING_LIBRARY && env.BOOK_BUCKET, 'reading_not_configured', 503);
    const owner = identity(principal.user_id);
    const stub = env.READING_LIBRARY.getByName(`reading-island:v1:owner:${owner}`);
    const segments = url.pathname.slice('/api/reading/'.length).split('/');
    const [resource, id, action] = segments;
    if (resource === 'profile' && segments.length === 1) {
      requireValue(principal.role === 'reader', 'forbidden', 403);
      requireValue(['GET', 'PATCH'].includes(request.method), 'method_not_allowed', 405);
      const body = request.method === 'PATCH' ? await readJson(request) : {};
      const result = await stub.call(owner, request.method === 'PATCH' ? 'putProfile' : 'getProfile', { username: body.username, revision: body.revision });
      return result.ok ? reply(result.value) : reply({error: result.error}, result.status);
    }
    if (resource === 'unread' && segments.length === 1 && request.method === 'GET') {
      requireValue(principal.role === 'reader', 'forbidden', 403);
      const result = await stub.call(owner, 'unread', {});
      return result.ok ? reply(result.value) : reply({error:result.error}, result.status);
    }
    requireValue(segments.length <= 3 && resources[resource], 'not_found', 404);
    const bird = principal.role === 'assistant';
    if (bird) {
      const allowed = request.method === 'GET' || (request.method === 'POST' && !id && ['books','groups','annotations','threads'].includes(resource)) || (request.method === 'PUT' && resource === 'documents' && id && !action);
      requireValue(allowed, 'forbidden', 403);
      if (request.method === 'PUT') {
        const book = await stub.call(owner,'get',{kind:'book',id:identity(url.searchParams.get('book_id'))});
        requireValue(book.ok && book.value.created_by === 'assistant','book_not_created_by_assistant',403);
      }
    }
    let operation, input;
    if (request.method === 'GET' && ((resource === 'books' && action === 'cover') || (resource === 'documents' && ['original', 'text'].includes(action)))) {
      const metadata = await stub.call(owner, 'get', { kind: resources[resource], id: identity(id) });
      if (!metadata.ok) return reply({ error: metadata.error }, metadata.status);
      const record = metadata.value, isCover = action === 'cover', isText = action === 'text';
      const hash = isCover ? record.cover_sha256 : isText ? record.text_sha256 : record.original_sha256;
      requireValue(hash && /^[a-f0-9]{64}$/.test(hash) && (isCover || record.status === 'ready'), 'file_unavailable', 404);
      const key = `reading-island/v1/owners/${owner}/books/${identity(record.book_id)}/${isCover ? 'covers/' + hash : 'objects/' + hash + (isText ? '.fulltext' : '.original')}`;
      const file = await env.BOOK_BUCKET.get(key);
      requireValue(file, 'file_unavailable', 404);
      return new Response(file.body, { headers: { 'Content-Type': isCover ? record.cover_type : isText ? 'text/plain; charset=utf-8' : 'application/octet-stream', 'Content-Length': String(file.size), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', ...(!isCover ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.filename)}` } : {}) } });
    } else if (request.method === 'PUT' && resource === 'books' && action === 'cover') {
      operation = 'cover'; input = { book_id: identity(id), revision: Number(url.searchParams.get('revision')), bytes: await readBody(request, 8 * 1024 * 1024) };
    } else if (request.method === 'PATCH' && resource === 'documents' && action === 'chapters') {
      operation = 'chapters'; input = { ...await readJson(request), document_id: identity(id) };
    } else if (request.method === 'POST' && resource === 'threads' && id && action === 'read') {
      operation = 'readThread'; input = { ...await readJson(request), thread_id: identity(id) };
    } else if (request.method === 'POST' && resource === 'threads' && id && action === 'messages') {
      operation = 'createUserTurn'; input = { ...await readJson(request), thread_id: identity(id) };
    } else if (request.method === 'POST' && resource === 'threads' && id && action === 'retry') {
      operation = 'prepareDispatch'; input = { turn_id: identity((await readJson(request)).turn_id) };
    } else if (request.method === 'PATCH' && resource === 'threads' && id && !action) {
      operation = 'threadStatus'; input = { ...await readJson(request), thread_id: identity(id) };
    } else if (request.method === 'DELETE' && resource === 'groups' && id && !action) {
      operation = 'deleteGroup'; input = { group_id: identity(id), revision: Number(url.searchParams.get('revision')) };
    } else if (request.method === 'GET' && action === 'context' && resource === 'threads') {
      operation = 'discussionContext'; input = { thread_id: identity(id) };
    } else if (request.method === 'GET' && action === 'source' && resource === 'documents') {
      operation = 'source'; input = { document_id: identity(id), book_id: identity(url.searchParams.get('book_id')), version: Number(url.searchParams.get('version')), text_sha256: url.searchParams.get('sha'), start: Number(url.searchParams.get('start') || 0), limit: Number(url.searchParams.get('limit') || 2000) };
    } else if (request.method === 'GET' && !action) {
      operation = id ? 'get' : 'list'; input = { kind: resources[resource], ...(id ? { id: identity(id) } : { after: url.searchParams.get('after') || '', limit: Number(url.searchParams.get('limit') || 50) }), ...(url.searchParams.has('book_id') ? { book_id: identity(url.searchParams.get('book_id')) } : {}), ...(url.searchParams.has('thread_id') ? { thread_id: identity(url.searchParams.get('thread_id')) } : {}) };
    } else if (request.method === 'PUT' && resource === 'documents' && id && !action) {
      operation = 'upload'; input = { document_id: identity(id), book_id: identity(url.searchParams.get('book_id')), filename: url.searchParams.get('filename'), bytes: await readBody(request, 25 * 1024 * 1024) };
    } else if (request.method === 'POST' && resource === 'documents' && id && action === 'progress') {
      operation = 'readingProgress'; input = { ...await readJson(request), document_id: identity(id) };
    } else if (request.method === 'POST' && !id) {
      operation = { books: 'createBook', groups: 'createGroup', annotations: 'createAnnotation', threads: 'createThread' }[resource];
      requireValue(operation, 'method_not_allowed', 405); input = await readJson(request);
    } else if (request.method === 'PATCH' && resource === 'books' && id && !action) {
      operation = 'updateBook'; input = { ...await readJson(request), book_id: identity(id) };
    } else throw new ReadingError(405, 'method_not_allowed');
    if (operation === 'createBook' && bird) input.created_by = 'assistant';
    else if (operation === 'createBook') delete input.created_by;
    if (bird && operation === 'createAnnotation') input.purpose = 'discussion';
    if (bird && operation === 'createThread') operation = 'createAssistantThread';
    const result = await stub.call(owner, operation, input);
    if (!result.ok) return reply({ error: result.error }, result.status);
    if (operation === 'upload') {
      // Include the book revision changed by this upload in its confirmed receipt.
      const book = await stub.call(owner, 'get', { kind: 'book', id: input.book_id });
      return reply({ ...result.value, ...(book.ok ? { book_snapshot: book.value } : {}) });
    }
    if (operation === 'createThread') {
      const dispatch = await dispatchReadingTurn(env, stub, result.value.opening_turn_id, owner, url.origin);
      const latest = await stub.call(owner, 'get', { kind: 'thread', id: result.value.thread_id });
      return reply({ ...(latest.ok ? latest.value : result.value), dispatch });
    }
    if (operation === 'createUserTurn') {
      const dispatch = await dispatchReadingTurn(env, stub, result.value.turn.turn_id, owner, url.origin);
      return reply({ ...result.value, dispatch });
    }
    if (operation === 'prepareDispatch') {
      requireValue(result.value.turn.thread_id === identity(id), 'not_found', 404);
      const dispatch = await dispatchReadingTurn(env, stub, result.value.turn.turn_id, owner, url.origin);
      return reply({ dispatch });
    }
    return reply(result.value);
  } catch (error) {
    return reply({ error: error instanceof ReadingError ? error.code : 'reading_unavailable' }, error instanceof ReadingError ? error.status : 503);
  }
}

export async function handleReadingGatewayApi(request, env) {
  try {
    requireValue(env.READING_LIBRARY && env.BOOK_BUCKET, 'reading_not_configured', 503);
    const path = new URL(request.url).pathname;
    requireValue(request.method === 'POST', 'method_not_allowed', 405);
    if (path === '/api/reading/gateway/source') {
      const claims = await sourcePrincipal(request, env);
      const input = await readJson(request);
      requireValue(input.thread_id === claims.thread_id, 'source_scope_mismatch', 403);
      const owner = identity(claims.user_id);
      const stub = env.READING_LIBRARY.getByName(`reading-island:v1:owner:${owner}`);
      const result = await stub.call(owner, 'gatewaySource', { thread_id: claims.thread_id, document_id: identity(input.document_id), version: Number(input.version), text_sha256: input.sha, start: Number(input.start ?? 0), limit: Number(input.limit ?? 2000) });
      return result.ok ? reply(result.value) : reply({error:result.error},result.status);
    }
    const payload = await readVerifiedGatewayJson(request, env);
    const owner = identity(payload.owner_id);
    const stub = env.READING_LIBRARY.getByName(`reading-island:v1:owner:${owner}`);
    const operation = path === '/api/reading/gateway/reply' ? 'applyReply' : path === '/api/reading/gateway/status' ? 'updateTurnStatus' : null;
    requireValue(operation, 'not_found', 404);
    const result = await stub.call(owner, operation, operation === 'applyReply' ? {reply:payload} : payload);
    if(result.ok && operation==='applyReply') {
      const next=await stub.call(owner,'nextPending',{thread_id:payload.thread_id});
      if(next.ok&&next.value)await dispatchReadingTurn(env,stub,next.value.turn_id,owner,new URL(request.url).origin);
    }
    return result.ok ? reply(result.value) : reply({error:result.error},result.status);
  } catch (error) { return reply({error:error instanceof ReadingError ? error.code : 'reading_gateway_unavailable'},error instanceof ReadingError ? error.status : 503); }
}

