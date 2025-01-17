import { Config, hc } from '@cloudflare/workers-honeycomb-logger'

const hcConfig: Config = {
  apiKey: HONEYCOMB_KEY,
  dataset: 'worker-discord-github-filter',
  sampleRates: {
    '2xx': 20,
    '3xx': 20,
    '4xx': 5,
    '5xx': 1,
    exception: 1,
  },
}

const SHIPIT_EMOTE = '<:shipit:826492371813400637>'

const listener = hc(hcConfig, (event) => {
  event.respondWith(handleRequest(event.request))
})

addEventListener('fetch', listener)

export async function handleRequest(request: Request): Promise<Response> {
  // Don't apply any logic to non-POSTs.
  if (request.method !== 'POST') {
    return new Response(
      'Worker lives! Ignoring this request because it is not a POST.',
    )
  }

  // Clone the request so that when we read JSON we can still forward it on later.
  let json = await request.clone().json()

  request.tracer.addData({
    githubEvent: request.headers.get('X-GitHub-Event'),
    sender: json.sender?.login,
  })

  // Check if username is like "joe[bot]" or coveralls.
  let isCoveralls = json.sender?.login?.indexOf('coveralls') !== -1
  let isGitHubBot = json.sender?.login?.indexOf('[bot]') !== -1
  let isSentry = json.sender?.login?.indexOf('sentry-io') !== -1
  let isDependabotBranchDelete =
    json.ref?.indexOf('dependabot') !== -1 &&
    request.headers.get('X-GitHub-Event') === 'delete'
  let isBotPRApprove =
    json.pull_request?.user?.login?.indexOf('[bot]') !== -1 &&
    request.headers.get('X-GitHub-Event') === 'pull_request_review'

  let isEmptyReview =
    json.review?.state === 'commented' &&
    request.headers.get('X-GitHub-Event') === 'pull_request_review' &&
    json.review?.body === null

  let isBlackNonMainPush =
    json.ref !== 'refs/heads/main' &&
    json.repository?.name == 'black' &&
    json.repository?.owner?.login == 'psf' &&
    request.headers.get('X-GitHub-Event') === 'push'

  // Combine logic.
  let botPayload =
    isCoveralls ||
    (isGitHubBot && !isSentry) ||
    isDependabotBranchDelete ||
    isBotPRApprove
  let noisyUserActions = isEmptyReview

  let shouldIgnore = botPayload || noisyUserActions || isBlackNonMainPush

  request.tracer.addData({ botPayload, noisyUserActions, shouldIgnore })

  // If payload is not from a bot.
  if (!shouldIgnore) {
    // Create a new URL object to break out the
    let url = new URL(request.url)

    // Check for invalid config.
    if (url.pathname === '/') {
      return new Response(
        'Make sure to specify webhook components like /:id/:token',
        { status: 400 },
      )
    }

    let [, id, token] = url.pathname.split('/')

    // Format for a webhook
    let template = `https://discord.com/api/webhooks/${id}/${token}/github?wait=1`

    let new_request = new Request(template, {
      body: (await request.text()).replaceAll(':shipit:', SHIPIT_EMOTE),
      headers: request.headers,
      method: request.method,
    })

    // Pass on data to Discord as usual
    return await fetch(template, new_request)
  }

  // Ignore any bot payload.
  return new Response(`Ignored by github-filter-worker`, { status: 203 })
}
