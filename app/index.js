const fs = require('fs')
const path = require('path')

const datetime = require('date-and-time')

const express = require('express')
const cors = require('cors')

const mustacheExpress = require('mustache-express')

const {google} = require('googleapis')
const googleAuth = require('./google-auth')

const app = express()

app.use(cors())

const urlEncOpts = {extended: false}
app.use(express.urlencoded(urlEncOpts))

const engine = mustacheExpress()
// register engine and use engine name as
// file extension of views file
app.engine('tmpl', engine)
app.set('view engine', 'tmpl') // set default extension of views file
app.set('views', 'views') // set default views file path

app.listen(3000, () => console.log('server started'))

const idlePeriodic = (cb, period) => {
    let handle
    const wrap = (...args) => {
        const next = (...args) => {
            if (handle) clearTimeout(handle)
            handle = setTimeout(
                () => wrap(...args),
                period
            )
        }
        cb(next, ...args)
    }
    return wrap
}

const aggregateCb = (cb) => {
    let cnt = 0
    const store = {}
    return (name, detail) => {
        ++cnt
        return (err, val) => {
            if (cnt === 0) return
            if (err) {
                cnt = 0
                const pack = {name, detail}
                return cb(err, pack)
            }
            store[name] = val
            if (--cnt === 0) cb(null, store)
        }
    }
}

const aggregator = aggregateCb(
    (err, res) => {
        if (err) {
            const {name, detail} = res
            return console.error(`${detail} failed`, err)
        }
        const {conf, auth} = res
        main(conf, auth)
    }
)

const confAgg = aggregator('conf', 'read config file')

fs.readFile(
    'config.json',
    (err, buf) => {
        if (err) return confAgg(err)
        const data = JSON.parse(buf)
        confAgg(null, data)
    }
)

googleAuth(
    ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    (url, cb) => {
        let used = false
        const handler = (req, res) => {
            if (used) return res.sendStatus(404)
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
            res.render('auth', data)
        }
        app.get('/auth', handler)
        app.post('/auth', handler)
    },
    aggregator('auth', 'get auth client')
)

const dateTimeFormat = datetime.compile('D/M/Y H:m Z')
const parseDateTime = (s) => datetime.parse(`${s} +0700`, dateTimeFormat)

const main = (conf, auth) => {
    const opts = {auth}
    google.options(opts)

    const mainSheetId = conf.sheetId

    const sheetsSvc = google.sheets('v4')
    const sheetsVals = sheetsSvc.spreadsheets.values

    const readSheets = (spreadsheetId, range, cb) => {
        sheetsVals.get(
            {spreadsheetId, range},
            (err, resp) => {
                if (err) return cb(err, null)
                const {data} = resp
                cb(null, data)
            }
        )
    }

    const reportConsole = (name) => (err) => {
        if (err) {
            console.error(`sync ${name} failed`, err)
            return
        }
        console.log(`sync ${name} success`)
    }

    const handleHttp = (name, sub) => (req, res) => sub(
        (err) => {
            if (err) {
                res.status(500)
                res.send(`sync ${name} failed`)
                return
            }
            res.send(`sync ${name} success`)
        }
    )

    const staticPath = 'data'

    const reportAnnounce = reportConsole('announce')
    const reportScore = reportConsole('score')
    const reportLive = reportConsole('live')
    const reportCompet = reportConsole('competition')

    const announceFile = path.join(staticPath, 'announce.json')
    const scoreFile = path.join(staticPath, 'score.json')
    const liveFile = path.join(staticPath, 'live.json')
    const competFile = path.join(staticPath, 'compet.json')

    const annouceReducer = (values) => {
        const [last] = values.slice(-1).map(
            (item) => {
                const [message] = item
                return {message}
            }
        )
        return last
    }

    const liveReducer = (values) => {
        const cleaned = !values ? [] : values.map(
            (row) => {
                const [dateText, timeText, stream] = row
                const schedule = parseDateTime(`${dateText} ${timeText}`)
                return {schedule, stream}
            }
        ).sort(
            (left, right) => {
                const elapse = datetime.subtract(
                    left.schedule,
                    right.schedule
                )
                return elapse.toMilliseconds()
            }
        )
        const now = new Date()
        // find live that is going to show in 10 minute
        const nextIndex = cleaned.findIndex(
            (row) => {
                const elapse = datetime.subtract(now, row.schedule)
                return elapse.toMinutes() < 10
            }
        )
        const live =
            nextIndex === -1 ?
            cleaned[cleaned.length - 1] :
            cleaned[nextIndex]
        return live
    }

    const competReducer = (values) => values.map(
        (row) => {
            const [dateText, timeText, game, teamLeft,teamRight, result] = row
            const schedule = parseDateTime(`${dateText} ${timeText}`)
            return {schedule, game, teamLeft, teamRight, result}
        }
    ).sort(
        (left, right) => {
            const elapse = datetime.subtract(
                left.schedule,
                right.schedule
            )
            return elapse.toMilliseconds()
        }
    )

    const scoreReducer = (values) => {
        const summed = {}
        for (const [scoreText, team, reason] of values) {
            const score = parseInt(scoreText, 10)
            const acc =
                team in summed ?
                summed[team] :
                summed[team] = {log: [], total: 0}
            const pack = {score, reason}
            acc.total += score
            acc.log.push(pack)
        }
        return summed
    }

    const syncAnnounce = idlePeriodic(
        (next, cb) => {
            readSheets(
                mainSheetId,
                'Announce!A2:A',
                (err, res) => {
                    if (err) return cb(err)
                    const {values} = res
                    const reduced = values ? annouceReducer(values) : null
                    fs.writeFile(announceFile, JSON.stringify(reduced), cb)
                }
            )
            next(reportAnnounce)
        },
        1000 * 60 * 10 // 10 minutes
    )

    const syncScore = idlePeriodic(
        (next, cb) => {
            readSheets(
                mainSheetId,
                'Score!A2:C',
                (err, res) => {
                    if (err) return cb(err)
                    const {values} = res
                    const reduced = values ? scoreReducer(values) : {
                        plant: {log: [], total: 0},
                        zombie: {log: [], total: 0}
                    }
                    fs.writeFile(scoreFile, JSON.stringify(reduced), cb)
                }
            )
            next(reportScore)
        },
        1000 * 60 * 20 // 20 minutes
    )

    const syncLive = idlePeriodic(
        (next, cb) => {
            readSheets(
                mainSheetId,
                'Stream!A2:C',
                (err, res) => {
                    if (err) return cb(err)
                    const {values} = res
                    const reduced = values ? liveReducer(values) : null
                    fs.writeFile(liveFile, JSON.stringify(reduced), cb)
                }
            )
            next(reportAnnounce)
        },
        1000 * 60 * 10 // 10 minutes
    )

    const syncCompet = idlePeriodic(
        (next, cb) => {
            readSheets(
                mainSheetId,
                'Competition!A2:G',
                (err, res) => {
                    if (err) return cb(err)
                    const {values} = res
                    const reduced = values ? competReducer(values) : []
                    fs.writeFile(competFile, JSON.stringify(reduced), cb)
                }
            )
            next(reportCompet)
        },
        1000 * 60 * 40 // 40 minutes
    )

    syncAnnounce(reportAnnounce)
    syncLive(reportLive)
    syncScore(reportScore)
    syncCompet(reportCompet)

    const updateRoute = express.Router()

    app.use('/update', updateRoute)

    const updateOpts = {
        endpoints: [
            {name: 'announce', label: 'announce'},
            {name: 'live', label: 'live'},
            {name: 'score', label: 'score'},
            {name: 'compet', label: 'competition'}
        ]
    }
    updateRoute.get('/', (req, res) => res.render('update', updateOpts))

    const handleAnnounceHttp = handleHttp('announce', syncAnnounce)
    const handleScoreHttp = handleHttp('score', syncScore)
    const handleLiveHttp = handleHttp('live', syncLive)
    const handleCompetHttp = handleHttp('competition', syncCompet)

    updateRoute.post('/announce', handleAnnounceHttp)
    updateRoute.post('/live', handleLiveHttp)
    updateRoute.post('/score', handleScoreHttp)
    updateRoute.post('/compet', handleCompetHttp)
}
