const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SIMKL_CLIENT_ID = 'test-client';
const simkl = require('../simkl');

test('anime is skipped and movies and shows are normalized', () => {
  assert.equal(simkl.normalizeTitle({ title: 'Akira', endpoint_type: 'anime', ids: { simkl_id: 1 } }), null);

  const movie = simkl.normalizeTitle({
    title: 'Dune', year: 2021, endpoint_type: 'movies', poster: 'abc',
    ids: { simkl_id: 77, slug: 'dune-2021', imdb: 'tt1160419' }, ratings: { simkl: { rating: 8.1 } },
  });
  assert.equal(movie.key, 'movie_77');
  assert.equal(movie.kind, 'movie');
  assert.equal(movie.siteUrl, 'https://simkl.com/movies/77/dune-2021');
  assert.equal(movie.poster, 'https://simkl.in/posters/abc_m.jpg');
  assert.equal(movie.rating, 8.1);

  const show = simkl.normalizeTitle({ title: 'Severance', endpoint_type: 'tv', ids: { simkl_id: 9 } });
  assert.equal(show.kind, 'show');
  assert.equal(show.key, 'show_9');
  assert.equal(show.poster, null);
});

test('newWatches returns only later watches, oldest first, and nothing on first run', () => {
  const items = [
    { key: 'a', watchedAt: '2026-11-10T10:00:00Z' },
    { key: 'b', watchedAt: '2026-11-12T10:00:00Z' },
    { key: 'c', watchedAt: '2026-11-11T10:00:00Z' },
    { key: 'd', watchedAt: null },
  ];
  assert.deepEqual(simkl.newWatches(items, null), []);
  assert.deepEqual(simkl.newWatches(items, '2026-11-10T10:00:00Z').map((i) => i.key), ['c', 'b']);
  assert.equal(simkl.latestWatch(items), '2026-11-12T10:00:00Z');
  assert.equal(simkl.latestWatch([]), null);
});

test('device login maps Simkl answers to states', async () => {
  const realFetch = global.fetch;
  const answers = [
    { status: 400, body: { error: 'authorization_pending' } },
    { status: 400, body: { error: 'slow_down' } },
    { status: 400, body: { error: 'access_denied' } },
    { status: 200, body: { access_token: 'tok-123' } },
  ];
  global.fetch = async () => {
    const a = answers.shift();
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.equal((await simkl.pollDeviceLogin('dev')).state, 'pending');
    assert.equal((await simkl.pollDeviceLogin('dev')).state, 'slow_down');
    assert.equal((await simkl.pollDeviceLogin('dev')).state, 'denied');
    const done = await simkl.pollDeviceLogin('dev');
    assert.equal(done.state, 'done');
    assert.equal(done.token, 'tok-123');
  } finally {
    global.fetch = realFetch;
  }
});

test('a 401 on the library surfaces its status for the caller', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(simkl.getWatched('old-token', 'movie'), (err) => err.status === 401);
  } finally {
    global.fetch = realFetch;
  }
});
