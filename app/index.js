const fs = require('fs')
const util = require('util')

const express = require('express')
const cors = require('cors')
const mustacheExpress = require('mustache-express')

const {google} = require('googleapis')
const googleAuth = require('./googleAuth')

const datetime = require('date-and-time')

let conf = JSON.parse(fs.readFileSync('config.json'))

let sheetId = conf.sheetId
let authClient

const app = express()
app.use(cors())
app.use(express.json())
app.use(
    express.urlencoded(
        {
            extended: false
        }
    )
)

const engine = mustacheExpress()
app.engine('mustache', engine)
app.set('view engine', 'mustache')
app.set('views', 'views')

googleAuth(
    ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    (url, cb) => {
        let used = false
        const handler = (req, res) => {
            // stop repeat initialization
            if (used) {
                res.status(400)
                res.send('already set up')
                return
            }
            if (req.method === 'POST') {
                const code = req.body.code
                cb(
                    code,
                    (err) => {
                        if (err) {
                            res.status(400)
                            res.send('wrong code')
                            return
                        }
                        res.send('finish set up')
                        used = true
                    }
                )
                return
            }
            const data = {url}
            res.render('init', data)
        }
        // expose init endpoint
        app.get('/init', handler)
        app.post('/init', handler)
    },
    (err, auth) => {
        if (err) return console.error('cannot get aauth client')
        
        authClient = auth
        // start sync
        syncScore(
            (err) => {
                if (err) return console.error('init save score failed', err)
                console.log('init save score success')
            }
        )
        syncAnnounce(
            (err) => {
                if (err) return console.error('init save announce failed', err)
                console.log('init save announce success')
            }
        )
        syncSchedule(
            (err) => {
                if (err) return console.error('init save schedule failed', err)
                console.log('init save schedule success')
            }
        )
    }
)

const updateRoute = express.Router()

// check for auth client before fetch
app.use(
    '/update',
    (req, res, next) => {
        if (authClient) return next()
        res.redirect('/init')
    },
    updateRoute
)

updateRoute.get(
    '/score',
    (req, res) => {
        syncScore(
            (err) => {
                if (err) return res.status(500).send('save score failed')
                res.send('save score success')
            }
        )
    }
)

updateRoute.get(
    '/announce',
    (req, res) => {
        syncAnnounce(
            (err) => {
                if (err) return res.status(500).send('save announce failed')
                res.send('save announce success')
            }
        )
    }
)

updateRoute.get(
    '/result',
    (req, res) => {
        syncSchedule(
            (err) => {
                if (err) return res.status(500).send('save schedule failed')
                res.send('save schedule success')
            }
        )
    }
)

// cache instances
let _sheetSvc
const sheetSvc = (auth) => {
    if (_sheetSvc) return _sheetSvc
    const sheets = google.sheets(
        {
            version: 'v4',
            auth: authClient
        }
    )
    return _sheetSvc = sheets.spreadsheets
}

let _sheetVals
const sheetVals = () => {
    if (_sheetVals) return _sheetVals
    const svc = sheetSvc()
    return _sheetVals = svc.values
}

const sheetData = (id, range, cb) => {
    const vals = sheetVals()
    vals.get(
        {
            spreadsheetId: id,
            range
        },
        (err, resp) => {
            if (err) return cb(err, null)
            cb(null, resp.data)
        }
    )
}

// sync functions
let syncScoreTimer
const syncScore = (cb) => {
    // cancel pending timer before set new one
    if (syncScoreTimer) clearTimeout(syncScoreTimer)
    // call itself periodically
    syncScoreTimer = setTimeout(
        () => syncScore(
            (err) => {
                if (err) return console.error('periodically save score failed')
                console.log('periodically save score success')
            }
        ),
        10 * 60 * 1000 // every 10 minute
    )
    sheetData(
        sheetId,
        'Score!A2:C',
        (err, res) => {
            if (err) return cb(err)
            // dummy value in case of empty sheet
            const rows = res.values ?? [
                [0, 'plant', 'dummy'],
                [0, 'zombie', 'dummy']
            ]
            // transform
            const reduced = {}
            for (const [scoreText, team, reason] of rows) {
                const score = parseInt(scoreText, 10)
                let teamItem
                if (team in reduced) {
                    teamItem = reduced[team]
                } else {
                    teamItem = reduced[team] = {
                        total: 0,
                        log: []
                    }
                }
                // accumulate
                teamItem.total += score
                teamItem.log.push(
                    {
                        score,
                        reason
                    }
                )
            }
            fs.writeFile(
                'data/score.json',
                JSON.stringify(reduced),
                cb
            )
        }
    )
}

let syncAnnounceTimer
const syncAnnounce = (cb) => {
    // cancel pending timer before set new one
    if (syncAnnounceTimer) clearTimeout(syncAnnounceTimer)
    // call itself periodically
    syncAnnounceTimer = setTimeout(
        () => syncAnnounce(
            (err) => {
                if (err) return console.error('periodically save announce failed')
                console.log('periodically save announce success')
            }
        ),
        10 * 60 * 1000 // 10 minutes
    )
    sheetData(
        sheetId,
        'Announce!A2:A',
        (err, res) => {
            if (err) return cb(err)
            // dummy value in case of empty sheet
            const rows = res.values ?? [['']]
            const cleanRows = rows.map(
                (item) => item[0]
            )
            fs.writeFile(
                'data/announce.json',
                JSON.stringify(cleanRows),
                cb
            )
        }
    )
}

const dateFormat = datetime.compile('D/M/Y H:m Z')

let syncScheduleTimer
const syncSchedule = (cb) => {
    // cancel pending timer before set new one
    if (syncScheduleTimer) clearTimeout(syncScheduleTimer)
    // call itself periodically
    syncScheduleTimer = setTimeout(
        () => syncSchedule(
            (err) => {
                if (err) return console.error('periodically save schedule failed')
                console.log('periodically save schedule success')
            }
        ),
        30 * 60 * 1000 // 30 minutes
    )
    sheetData(
        sheetId,
        'Result!A2:G',
        (err, res) => {
            if (err) return cb(err)
            // dummy value in case of empty sheet
            const rows = res.values ?? [
                ['1/1/1', '7:0', 'http://google.com', 'minecraft', 'left', 'right', 'draw']
            ]
            // transform
            const cleanedRows = rows.map(
                (row) => {
                    const [
                        dateText,
                        timeText,
                        stream,
                        game,
                        teamL,
                        teamR,
                        result
                    ] = row
                    const schedule = datetime.parse(`${dateText} ${timeText} +0700`, dateFormat)
                    return {
                        schedule,
                        stream,
                        game,
                        teamL,
                        teamR,
                        result
                    }
                }
            ).sort(
                (left, right) => {
                    const elapse = datetime.subtract(left.schedule, right.schedule)
                    return elapse.toMilliseconds()
                }
            )
            // filter
            const now = new Date()
            const incomingOffset = cleanedRows.findIndex(
                (row) => {
                    const elapse = datetime.subtract(now, row.schedule)
                    return elapse.toMilliseconds() < 0
                }
            )
            const liveSource = incomingOffset === -1 ? cleanedRows.reverse() : cleanedRows.slice(incomingOffset)
            const live = liveSource.find(
                (row) => !!row.stream
            )

            // aggregate callbacks into 1
            let aggCount = 2
            const aggCb = (err) => {
                if (aggCount > 0) {
                    if (err) {
                        aggCount = 0
                        return cb(err)
                    }
                    if (--aggCount === 0) cb(null)
                }
            }

            fs.writeFile(
                'data/result.json',
                JSON.stringify(cleanedRows),
                aggCb
            )
            fs.writeFile(
                'data/live.json',
                JSON.stringify(live),
                aggCb
            )
        }
    )
}

const port = process.env.PORT ?? 3000

app.listen(port, () => console.log(`server is running on port ${port}`))
