const fs = require('fs')

const {google} = require('googleapis')

const init = (scopes, askCb, clientCb) => {
    // read shared secret
    fs.readFile(
        'client_secret.json',
        (err, buf) => {
            if (err) clientCb(err, null)
            const {
                client_secret,
                client_id,
                redirect_uris
            } = JSON.parse(buf)
            const client = new google.auth.OAuth2(
                client_id,
                client_secret,
                redirect_uris[0]
            )
            // read stored token
            fs.readFile(
                'token.json',
                (err, buf) => {
                    if (err) return get(client, scopes, askCb, clientCb)
                    const data = JSON.parse(buf)
                    client.setCredentials(data)
                    clientCb(null, client)
                }
            )
        }
    )
}

const get = (client, scopes, askCb, clientCb) => {
    const authOpts = {scope: scopes, access_type: 'offline'}
    const authUrl = client.generateAuthUrl(authOpts)
    // ask user to go to url and get the code
    askCb(
        authUrl,
        // user send code to us and want to know result
        (code, resCb) => {
            client.getToken(
                code,
                (err, tok) => {
                    // tell user result of the code
                    if (err) return resCb(err)
                    resCb(null)
                    // write token for later use
                    fs.writeFile(
                        'token.json',
                        JSON.stringify(tok),
                        (err) => {
                            if (err) return console.error('save token failed')
                            console.log('save token success')
                        }
                    )
                    client.setCredentials(tok)
                    clientCb(null, client)
                }
            )
        }
    )
}

module.exports = init
