const fs = require('fs')
const path = require('path')

const datetime = require('date-and-time')

const express = require('express')
const cors = require('cors')

const mustacheExpress = require('mustache-express')

const {google} = require('googleapis')
const googleAuth = require('./google-auth')
const { file } = require('googleapis/build/src/apis/file')

const dirOpts = {depth: 99}

const app = express()

app.use(cors())

const urlEncOpts = {extended: false}
app.use(express.urlencoded(urlEncOpts))
app.use(express.json())

const engine = mustacheExpress()
// register engine and use engine name as
// file extension of views file
app.engine('tmpl', engine)
app.set('view engine', 'tmpl') // set default extension of views file
app.set('views', 'views') // set default views file path

app.listen(3000, () => console.log('server started'))

const undefToNull = (k, v) => v === undefined ? null : v

const idlePeriodic = (cb, period) => {
    let handle
    const wrap = (...args) => {
        const again = (...args) => {
            if (handle) clearTimeout(handle)
            handle = setTimeout(
                () => wrap(...args),
                period
            )
        }
        cb(again, ...args)
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
            res.render('gg-auth', data)
        }
        app.get('/gg-auth', handler)
        app.post('/gg-auth', handler)
    },
    aggregator('auth', 'get auth client')
)

const dateFormat = datetime.compile('D/M/Y H:m Z')

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
        if (err) return console.error(`sync ${name} failed`, err)
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

    const reportAnnounceConsole = reportConsole('announce')
    const reportScoreConsole = reportConsole('score')
    const reportCompetConsole = reportConsole('competition')

    const announceFile = path.join(conf.staticPath, 'announce.json')
    const scoreFile = path.join(conf.staticPath, 'score.json')
    const liveFile = path.join(conf.staticPath, 'live.json')
    const competFile = path.join(conf.staticPath, 'compet.json')

    const annouceReducer = (values) => values.slice(-1).map(
        (item) => {
            const [message] = item
            return {message}
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
        (again, cb) => readSheets(
            mainSheetId,
            'Announce!A2:A',
            (err, res) => {
                if (err) {
                    cb(err)
                    again(reportAnnounceConsole)
                    return
                }
                const {values} = res
                const reduced = values ? annouceReducer(values) : []
                fs.writeFile(announceFile, JSON.stringify(reduced), cb)
                again(reportAnnounceConsole)
            }
        ),
        1000 * 60 * 10 // 10 minutes
    )

    const syncScore = idlePeriodic(
        (again, cb) => readSheets(
            mainSheetId,
            'Score!A2:C',
            (err, res) => {
                if (err) {
                    cb(err)
                    again(reportScoreConsole)
                    return
                }
                const {values} = res
                const reduced = values ? scoreReducer(values) : {
                    plant: {log: [], total: 0},
                    zombie: {log: [], total: 0}
                }
                fs.writeFile(scoreFile, JSON.stringify(reduced), cb)
                again(reportScoreConsole)
            }
        ),
        1000 * 60 * 20 // 20 minutes
    )

    const syncCompet = idlePeriodic(
        (again, cb) => readSheets(
            mainSheetId,
            'Competition!A2:G',
            (err, res) => {
                if (err) {
                    cb(err)
                    again(reportCompetConsole)
                    return
                }
                const {values} = res
                const cleaned = !values ? [] : values.map(
                    (row) => {
                        const [
                            dateText,
                            timeText,
                            game,
                            teamLeft,
                            teamRight,
                            result,
                            stream
                        ] = row
                        const schedule = datetime.parse(
                            `${dateText} ${timeText} +0700`,
                            dateFormat
                        )
                        return {
                            schedule,
                            game,
                            teamLeft,
                            teamRight,
                            result,
                            stream
                        }
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
                const incomingOffset = cleaned.findIndex(
                    (row) => {
                        const elapse = datetime.subtract(now, row.schedule)
                        return elapse.toMilliseconds() < 0
                    }
                )
                const liveSource =
                    incomingOffset === -1 ?
                    cleaned.reverse() :
                    cleaned.slice(incomingOffset)
                const availLive = liveSource.find((row) => !!row.stream)
                const aggregator = aggregateCb(cb)
                fs.writeFile(
                    liveFile,
                    JSON.stringify(availLive, undefToNull),
                    aggregator('live', 'write live file')
                )
                fs.writeFile(
                    competFile,
                    JSON.stringify(cleaned),
                    aggregator('compet', 'write competition file')
                )
                again(reportCompetConsole)
            }
        ),
        1000 * 60 * 60 // 1 hour
    )

    syncAnnounce(reportAnnounceConsole)
    syncScore(reportScoreConsole)
    syncCompet(reportCompetConsole)

    const updateRoute = express.Router()

    app.use('/update', updateRoute)

    const handleAnnounceHttp = handleHttp('announce', syncAnnounce)
    const handleScoreHttp = handleHttp('score', syncScore)
    const handleCompetHttp = handleHttp('competition', syncCompet)

    updateRoute.get('/announce', handleAnnounceHttp)
    updateRoute.get('/score', handleScoreHttp)
    updateRoute.get('/compet', handleCompetHttp)
}
