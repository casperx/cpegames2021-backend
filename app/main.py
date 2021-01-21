import asyncio
from collections import defaultdict
from aiohttp import web
import aiohttp_cors
from sheets import sheetsService, sheetId

sheetService = sheetsService()
sheetValues = sheetService.values()

async def index(req):
    return web.Response(text='pong')

async def score(req):
    d = req.app['state']['score']
    return web.json_response(d)

async def updateScore(req):
    # force fetch
    fetcher(req.app)

    return web.Response(text='ok')

cors_defaults = {
    '*': aiohttp_cors.ResourceOptions(
        expose_headers='*',
        allow_headers='*',
    )
}

def setup():
    app = web.Application()

    cors = aiohttp_cors.setup(app, defaults=cors_defaults)

    cors.add(app.router.add_route('GET', '/', index))
    cors.add(app.router.add_route('GET', '/score', score))
    cors.add(app.router.add_route('POST', '/score/update', updateScore))

    app['state'] = {}

    return app

def fetcher(app):
    print('fetch data')
    
    if 'timer' in app['state']:
        # clear old timer before set new one
        app['state']['timer'].cancel()

    res = sheetValues.get(spreadsheetId=sheetId, range='Score!A2:B').execute()

    summary = defaultdict(int)

    for added_score, team in res['values']:
        # accumulate score
        summary[team] += int(added_score)

    app['state']['score'] = summary

    # set timer to call itself
    app['state']['timer'] = asyncio.get_event_loop().call_later(60, fetcher, app)


def main():
    app = setup()

    # start fetcher
    fetcher(app)

    web.run_app(app)

if __name__ == '__main__':
    main()
