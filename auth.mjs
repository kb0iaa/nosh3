import dotenv from 'dotenv'
dotenv.config()
import axios from 'axios'
import crypto from 'crypto'
import express from 'express'
import fs from 'fs'
import isReachable from 'is-reachable'
import * as jose from 'jose'
// const Mailgun = require('mailgun.js')
import objectPath from 'object-path'
import PouchDB from 'pouchdb'
import settings from './settings.mjs'
import { v4 as uuidv4 } from 'uuid'
import { couchdbDatabase, couchdbInstall, createKeyPair, createSigner, equals, extractComponent, extractHeader, getKeys, getNPI, getPIN, signatureHeader, sync, urlFix, verify, verifyPIN } from './core.mjs'
// const mailgun = new Mailgun(formData)
// const mg = mailgun.client({username: 'api', key: process.env.MAILGUN_API_KEY})
const router = express.Router()
const options = {
  // scope: ['read', 'write']
  claims: [
    // {name: 'sub'},
    {name: 'aud', value: 'urn:example:audience'}
  ]
}
import PouchDBFind from 'pouchdb-find'
PouchDB.plugin(PouchDBFind)
export default router
// const jwksService = jose.createRemoteJWKSet(new URL(settings.jwks_uri))

router.post('/verifyJWT', verifyJWTEndpoint)
router.get('/jwks', jwks) // endpoint to share public key
router.get('/config', config)
// router.post('/save', save)
router.post('/authenticate', authenticate)
router.get('/exportJWT', exportJWT)
router.post('/addPatient', addPatient)

router.get('/addUser', addUser)

router.post('/gnapAuth', gnapAuth)
router.get('/gnapVerify', gnapVerify)

router.post('/pinCheck', pinCheck)
router.post('/pinClear', pinClear)
router.post('/pinSet', pinSet)

router.post('/mail', mail)
router.get('/test', test)

function config(req, res) {
  if (req.get('referer') === req.protocol + '://' + req.hostname + '/app/login') {
    var response = {
      auth: process.env.AUTH
    }
    if (process.env.AUTH === 'magic') {
      objectPath.set(response, 'key', process.env.MAGIC_API_KEY)
    }
    if (process.env.AUTH === 'trustee') {
      objectPath.set(response, 'key', process.env.GNAP_API_KEY)
      objectPath.set(response, 'url', process.env.TRUSTEE_URL)
    }
    objectPath.set(response, 'instance', process.env.INSTANCE)
    if (process.env.NOSH_ROLE === 'patient') {
      objectPath.set(response, 'type', 'pnosh')
    } else {
      objectPath.set(response, 'type', 'mdnosh')
    }
    res.status(200).json(response)
  } else {
    res.status(401).send('Unauthorized')
  }
}

// async function save(req, res) {
//   if (req.get('referer') === req.protocol + '://' + req.hostname + '/app/login') {
//     const db = new PouchDB((settings.couchdb_uri + '/magic'), settings.couchdb_auth)
//     var doc = req.body
//     objectPath.set(doc, '_id', 'nosh_' + uuidv4())
//     await db.put(doc)
//     res.status(200).json(doc)
//   } else {
//     res.status(401).send('Unauthorized')
//   }
// }

async function authenticate(req, res) {
  if (req.get('referer') === req.protocol + '://' + req.hostname + '/app/login') {
    if (req.body.auth === 'magic') {
      var email = req.body.email
    }
    var pin = process.env.COUCHDB_ENCRYPT_PIN
    var prefix = ''
    if (process.env.INSTANCE === 'digitalocean' && process.env.NOSH_ROLE === 'patient') {
      prefix = req.body.patient + '_'
      pin = await getPIN(req.body.patient)
      if (!pin) {
        res.status(401).send('Unauthorized - No PIN set')
      }
    }
    const db_users = new PouchDB(urlFix(settings.couchdb_uri) + prefix + 'users', settings.couchdb_auth)
    const result_users = await db_users.find({
      selector: {'email': {$eq: email}}
    })
    if (result_users.docs.length > 0) {
      var payload = {
        "_auth": req.body,
        "_nosh": {
          "email": email,
          "id": result_users.docs[0].id,
          "display": result_users.docs[0].display,
          "did": '',
          "pin": pin,
          "trustee": '',
          "instance": process.env.INSTANCE
        },
        "_noshAuth": process.env.AUTH,
        "_noshAPI": {
          "uspstf_key": process.env.USPSTF_KEY,
          "umls_key": process.env.UMLS_KEY,
          "mailgun_key": process.env.MAILGUN_API_KEY,
          "mailgun_domain": process.env.MAILGUN_DOMAIN,
          "oidc_relay_url": process.env.OIDC_RELAY_URL
        }
      }
      if (!objectPath.has(result_users, 'docs.0.defaults')) {
        const user_doc = await db_users.get(result_users.docs[0]._id)
        const defaults = {
          "class": 'AMB',
          "type": '14736009',
          "serviceType": '124',
          "serviceCategory": ' 17',
          "appointmentType": 'ROUTINE',
          "category": '34109-9',
          "code": '34108-1'
        }
        objectPath.set(user_doc, 'defaults', defaults)
        await db_users.put(user_doc)
      }
      if (process.env.INSTANCE == 'dev') {
        objectPath.set(payload, '_noshDB', urlFix(req.protocol + '://' + req.hostname + '/couchdb'))
      } else {
        objectPath.set(payload, '_noshDB', urlFix(process.env.COUCHDB_URL))
      }
      if (process.env.AUTH == 'trustee') {
        objectPath.set(payload, '_nosh.trustee', urlFix(process.env.TRUSTEE_URL) )
      }
      if (process.env.NOSH_ROLE == 'patient') {
        await sync('patients', req.body.patient)
        const db_patients = new PouchDB(prefix + 'patients')
        const result_patients = await db_patients.find({selector: {_id: {$regex: '^nosh_*'}}})
        if (result_patients.docs.length > 0) {
          if (req.body.route === null) {
            objectPath.set(payload, '_noshRedirect', '/app/chart/' + result_patients.docs[0]._id)
          } else {
            objectPath.set(payload, '_noshRedirect', req.body.route)
          }
          objectPath.set(payload, '_noshType', 'pnosh')
          objectPath.set(payload, '_nosh.patient', result_patients.docs[0]._id)
          const jwt = await createJWT(result_users.docs[0].id, urlFix(req.protocol + '://' + req.hostname + '/'), urlFix(req.protocol + '://' + req.hostname + '/'), payload)
          res.status(200).send(jwt)
        } else {
          // not installed yet
          res.redirect(urlFix(req.protocol + '://' + req.hostname + '/') + 'start')
        }
      } else {
        if (req.body.route === null) {
          objectPath.set(payload, '_noshRedirect', '/app/dashboard')
        } else {
          objectPath.set(payload, '_noshRedirect', req.body.route)
        }
        objectPath.set(payload, '_noshType', 'mdnosh')
        const jwt = await createJWT(result_users.docs[0].id, urlFix(req.protocol + '://' + req.hostname + '/'), urlFix(req.protocol + '://' + req.hostname + '/'), payload)
        res.status(200).send(jwt)
      }
    } else {
      res.status(401).send('Unauthorized - User not found')
    }
  } else {
    res.status(401).send('Unauthorized - URL does not match')
  }
}

async function gnapAuth(req, res) {
  var pin = process.env.COUCHDB_ENCRYPT_PIN
  var prefix = ''
  if (process.env.INSTANCE === 'digitalocean' && process.env.NOSH_ROLE === 'patient') {
    prefix = req.body.patient + '_'
    pin = await getPIN(req.body.patient)
    if (!pin) {
      res.status(401).send('Unauthorized - No PIN set')
    }
  }
  var keys = await getKeys()
  if (keys.length === 0) {
    var pair = await createKeyPair()
    keys.push(pair)
  }
  const body = {
    "access_token": {
      "access": ["app"],
      "actions": ["read", "write"],
      "locations": [req.protocol + "://" + req.hostname + "/app/chart/" + req.body.patient]
    },
    "client": {
      "display": {
        "name": "NOSH",
        "uri": req.protocol + "://" + req.hostname
      },
      "key": {
        "proof": "httpsig",
        "jwk": keys[0].publicKey
      }
    },
    "interact": {
      "start": ["redirect"],
      "finish": {
        "method": "redirect",
        "uri": req.protocol + "://" + req.hostname + "/auth/gnapVerify",
        "nonce": crypto.randomBytes(16).toString('base64url')
      }
    }
  }
  const pre_headers = {
    "content-digest": "sha-256=:" + crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') + "=:",
    "content-length": JSON.stringify(body).length,
    "content-type": "application/json"
  }
  const headers = await signatureHeader({
    method: 'POST',
    url: urlFix(process.env.TRUSTEE_URL) + 'api/as/tx',
    headers: pre_headers,
    body: body
  },{
    components: [
      '@method',
      '@target-uri',
      'content-digest',
      'content-length',
      'content-type'
    ],
    parameters: {
      created: Math.floor(Date.now() / 1000),
      nonce: crypto.randomBytes(16).toString('base64url'),
      tag: "gnap",
      keyid: keys[0].publicKey.kid,
      alg: 'rsa-v1_5-sha256'
    },
    key: keys[0]
  })
  const opts = {
    headers: headers
  }
  try {
    var response = await axios.post(urlFix(process.env.TRUSTEE_URL) + 'api/as/tx', body, opts)
    var doc = response.data
    var db = new PouchDB(urlFix(settings.couchdb_uri) + prefix + 'gnap', settings.couchdb_auth)
    objectPath.set(doc, '_id', 'nosh_' + uuidv4())
    objectPath.set(doc, 'nonce', objectPath.get(body, 'interact.finish.nonce'))
    objectPath.set(doc, 'route', req.body.route)
    objectPath.set(doc, 'patient', req.body.patient)
    await db.put(doc)
    res.status(200).json(doc)
  } catch (e) {
    res.status(401).json(e)
  }
}

async function gnapVerify(req, res) {
  var db = new PouchDB(urlFix(settings.couchdb_uri) + 'gnap', settings.couchdb_auth)
  var result = await db.find({
    selector: {_id: {"$gte": null}, nonce: {"$eq": req.query.state_id}}
  })
  var index = null
  for (var a in result.docs) {
    // calculate hash and confirm match
    const hash = crypto.createHash('sha3-512')
    hash.update(result.docs[a].nonce + '\n')
    hash.update(result.docs[a].interact.finish + '\n')
    hash.update(req.query.interact_ref + '\n')
    hash.update(urlFix(process.env.TRUSTEE_URL) + 'api/as/tx')
    const hash_result = hash.digest('base64url')
    if (hash_result === req.query.hash) {
      index = a
    }
  }
  if (index !== null) {
    var body = {"interact_ref": req.query.interact_ref}
    try {
      var response = await axios.post(result.docs[index].continue.uri, body)
      var prefix = ''
      var pin = process.env.COUCHDB_ENCRYPT_PIN
      const patient_id = result.docs[index].patient
      if (process.env.INSTANCE === 'digitalocean' && process.env.NOSH_ROLE === 'patient') {
        prefix = patient_id + '_'
        pin = await getPIN(patient_id)
        if (!pin) {
          res.status(401).send('Unauthorized - No PIN set')
        }
      }
      db.remove(result.docs[index])
      // subject must be in the response
      if (objectPath.has(response.data, 'subject')) {
        var selector = []
        var nosh = {
          email: '',
          did: '',
          pin: pin,
          npi: '',
          templates: []
        }
        var user_id = ''
        var email_id = response.data.subject.sub_ids.find(b => b.format === 'email')
        if (email_id !== undefined) {
          selector.push({'email': {$eq: email_id.email}, _id: {"$gte": null}})
          objectPath.set(nosh, 'email', email_id.email)
        }
        var did_id = response.data.subject.sub_ids.find(b => b.format === 'did')
        if (did_id !== undefined) {
          selector.push({'did': {$eq: did_id.url}, _id: {"$gte": null}})
          objectPath.set(nosh, 'did', did_id.url)
        }
        var db_users = new PouchDB(urlFix(settings.couchdb_uri) + prefix + 'users', settings.couchdb_auth)
        var result_users = await db_users.find({
          selector: {$or: selector}
        })
        // assume access token is JWT that contains verifiable credentials and if valid, attach to payload
        const jwt = response.data.access_token.value
        const verify_results = await verify(jwt)
        if (verify_results.status === 'isValid') {
          if (objectPath.has(verify_results, 'payload.vc')) {
            objectPath.set(nosh, 'npi', getNPI(objectPath.get(verify_results, 'payload.vc')))
          }
          if (objectPath.has(verify_results, 'payload.vp') && npi !== '') {
            for (var b in objectPath.get(verify_results, 'payload.vp.verifiableCredential')) {
              if (npi !== '') {
                objectPath.set(nosh, 'npi', getNPI(objectPath.get(verify_results, 'payload.vp.verifiableCredential.' + b )))
              }
            }
          }
          var payload = {
            "_gnap": response.data,
            "jwt": jwt
          }
          if (result_users.docs.length > 0) {
            if (!objectPath.has(result_users, 'docs.0.defaults')) {
              const user_doc = await db_users.get(result_users.docs[0]._id)
              const defaults = {
                "class": 'AMB',
                "type": '14736009',
                "serviceType": '124',
                "serviceCategory": ' 17',
                "appointmentType": 'ROUTINE',
                "category": '34109-9',
                "code": '34108-1'
              }
              objectPath.set(user_doc, 'defaults', defaults)
              await db_users.put(user_doc)
            }
            user_id = result_users.docs[0].id
            if (objectPath.has(verify_results, 'payload._nosh')) {
              // there is an updated user object from wallet, so sync to this instance
              if (!equals(objectPath.get(verify_results, 'payload._nosh'), result_users.docs[0])) {
                await db_users.put(objectPath.get(verify_results, 'payload._nosh'))
              }
            } else {
              // update user as this is a new instance
              var doc = result_users.docs[0]
              objectPath.set(nosh, '_id', doc._id)
              objectPath.set(nosh, 'id', doc.id)
              objectPath.set(nosh, '_rev', doc._rev)
              await db_users.put(nosh)
            }
            objectPath.set(nosh, 'id', user_id)
            objectPath.set(nosh, 'display', result_users.docs[0].display)
          } else {
            // add new user - authorization server has already granted
            var id = 'nosh_' + uuidv4()
            objectPath.set(nosh, '_id', id)
            objectPath.set(nosh, 'id', id)
            objectPath.set(nosh, 'templates', JSON.parse(fs.readFileSync('./assets/templates.json')))
            objectPath.set(nosh, 'display', '') // grab display from authorization server - to be completed
            await db_users.put(nosh)
            objectPath.set(nosh, 'display', objectPath.get(nosh, 'display'))
          }
          objectPath.set(payload, '_nosh', nosh)
          objectPath.set(payload, '_noshAuth', process.env.AUTH)
          if (process.env.INSTANCE == 'dev') {
            objectPath.set(payload, '_noshDB', urlFix(req.protocol + '://' + req.hostname + '/couchdb'))
          } else {
            objectPath.set(payload, '_noshDB', urlFix(process.env.COUCHDB_URL))
          }
          const api = {
            "uspstf_key": process.env.USPSTF_KEY,
            "umls_key": process.env.UMLS_KEY,
            "mailgun_key": process.env.MAILGUN_API_KEY,
            "mailgun_domain": process.env.MAILGUN_DOMAIN
          }
          objectPath.set(payload, 'noshAPI', api)
          if (process.env.NOSH_ROLE == 'patient') {
            await sync('patients', patient_id)
            const db_patients = new PouchDB(prefix + 'patients')
            const result_patients = await db_patients.find({selector: {'isEncrypted': {$eq: true}}})
            if (result_patients.docs.length === 1) {
              if (result.docs[0].route === null) {
                objectPath.set(payload, '_noshRedirect','/app/chart/' + result_patients.docs[0]._id)
              } else {
                objectPath.set(payload, '_noshRedirect', result.docs[0].route)
              }
              objectPath.set(payload, '_noshType', 'pnosh')
              objectPath.set(payload, '_nosh.patient', patient_id)
            } else {
              // not installed yet
              res.redirect(urlFix(req.protocol + '://' + req.hostname + '/') + 'start')
            }
          } else {
            if (result.docs[0].route === null) {
              objectPath.set(payload, '_noshRedirect', '/app/dashboard/')
            } else {
              objectPath.set(payload, '_noshRedirect', result.docs[0].route)
            }
            objectPath.set(payload, '_noshType', 'mdnosh')
          }
          const jwt = await createJWT(user_id, urlFix(req.protocol + '://' + req.hostname + '/'), urlFix(req.protocol + '://' + req.hostname + '/'), payload)
          res.redirect(urlFix(req.protocol + '://' + req.hostname + '/') + 'app/verifyUser?token=' + jwt)
        } else {
          res.status(401).send('Unauthorized')
        }
      }
    } catch (e) {
      res.status(401).json(e)
    }
  }
}

async function mail(req, res) {
  const jwt = await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer('urn:example:issuer')
    .setAudience('urn:example:audience')
    .setExpirationTime('2m')
    .sign(rsaPrivateKey)
  // mg.messages.create(process.env.MAILGUN_DOMAIN, {
  //   from: fromEmail,
  //   to: toEmails,
  //   subject: 'Hello',
  //   html: '<img src="cid:mailgun.png" width="200px"><br><h3>Testing some Mailgun awesomness!</h3>',
  //   text: 'Testing some Mailgun awesomness!',
  //   inline: [mailgunLogo],
  //   attachment: [rackspaceLogo]
  // }).then((msg) => console.log(msg))
  //   .catch((err) => console.log(err))
}

async function createJWT(sub, aud, iss, payload=null) {
  // aud is audience - base url of this server
  var keys = await getKeys()
  if (keys.length === 0) {
    var pair = await createKeyPair()
    keys.push(pair)
  }
  const rsaPrivateKey = await jose.importJWK(keys[0].privateKey, 'RS256')
  const payload_vc = {
    "vc": {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://www.w3.org/2018/credentials/examples/v1"
      ],
      "id": "http://example.edu/credentials/3732",
      "type": [
        "VerifiableCredential",
        "UniversityDegreeCredential"
      ],
      "issuer": "https://example.edu/issuers/565049",
      "issuanceDate": "2010-01-01T00:00:00Z",
      "credentialSubject": {
        "id": "did:example:ebfeb1f712ebc6f1c276e12ec21",
        "degree": {
          "type": "BachelorDegree",
          "name": "Bachelor of Science and Arts"
        }
      }
    },
    // app specific payload
    "_couchdb.roles": ["_admin"],
    "_nosh": {
      "role": "provider" // provider, patient, support, proxy
    }
  }
  if (payload !== null) {
    var payload_final = {
      ...payload_vc,
      ...payload
    }
  } else {
    var payload_final = payload_vc
  }
  var header = { alg: 'RS256' }
  const jwt = await new jose.SignJWT(payload_final)
    .setProtectedHeader(header)
    .setIssuedAt()
    .setIssuer(iss)
    .setAudience(aud)
    .setExpirationTime('2h')
    .setSubject(sub)
    .sign(rsaPrivateKey)
  return jwt
}

async function verifyJWTEndpoint(req, res) {
  const ret = await verify(req.body.token)
  res.status(200).send(ret)
}

async function exportJWT(req, res) {
  var keys = await getKeys()
  if (keys.length === 0) {
    var pair = await createKeyPair()
    keys.push(pair)
  }
  const key = await jose.importJWK(keys[0].publicKey)
  const pem = await jose.exportSPKI(key)
  res.status(200).json(pem)
}

async function jwks(req, res) {
  var keys_arr = []
  var keys = await getKeys()
  if (keys.length === 0) {
    var pair = await createKeyPair()
    keys.push(pair)
  }
  keys_arr.push(keys[0].publicKey)
  res.status(200).json({
    keys: keys_arr
  })
}

async function addPatient(req, res, next) {
  var opts = JSON.parse(JSON.stringify(settings.couchdb_auth))
  objectPath.set(opts, 'skip_setup', true)
  const check = new PouchDB(urlFix(settings.couchdb_uri) + '_users', opts)
  var info = await check.info()
  var b = false
  if (objectPath.has(info, 'error')) {
    if (info.error == 'not_found') {
      await couchdbInstall()
      var c = 0
      while (!b && c < 40) {
        b = await isReachable(settings.couchdb_uri)
        if (b || c === 39) {
          break
        } else {
          c++
        }
      }
    }
  } else {
    b = true
  }
  if (b) {
    const id = 'nosh_' + uuidv4()
    const user = {
      display: req.body.user.display,
      id: id,
      _id: id,
      email: req.body.user.email,
      role: 'patient',
      did: req.body.user.did
    }
    var patient_id = 'nosh_' + uuidv4()
    const patient = {
      "_id": patient_id,
      "resourceType": "Patient",
      "id": patient_id,
      "name": [
        {
          "family": req.body.patient.lastname,
          "given": [
            req.body.patient.firstname
          ],
          "use": "official",
        }
      ],
      "text": {
        "status": "generated",
        "div": "<div xmlns=\"http://www.w3.org/1999/xhtml\">" + req.body.patient.firstname + ' ' + req.body.patient.lastname + "</div>"
      },
      "birthDate": req.body.patient.dob,
      "gender": req.body.patient.gender,
      "extension": [
        {
          "url": "http://hl7.org/fhir/us/core/StructureDefinition/us-core-race"
        },
        {
          "url": "http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity"
        },
        {
          "url": "http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex",
          "valueCode": req.body.patient.birthgender
        }
      ]
    }
    const salt = crypto.randomBytes(16).toString('hex')
    const hash = crypto.pbkdf2Sync(req.body.pin, salt, 1000, 64, 'sha512').toString('hex')
    const pin = {
      _id: patient_id,
      hash: hash,
      salt: salt
    }
    const pin1 = {
      _id: patient_id,
      pin: req.body.pin
    }
    const hashpins = new PouchDB('hashpins')
    await hashpins.put(pin)
    const pindb = new PouchDB('pins')
    await pindb.put(pin1)
    const remote_hashpins = new PouchDB(urlFix(settings.couchdb_uri) + 'hashpins', settings.couchdb_auth)
    await hashpins.sync(remote_hashpins).on('complete', () => {
      console.log('PouchDB sync complete for DB: hashpins')
    }).on('error', (err) => {
      console.log(err)
    })
    await sync('patients', patient_id, true, patient)
    objectPath.set(user, 'reference', 'Patient/' + patient_id)
    await sync('users', patient_id, true, user)
    await couchdbDatabase(patient_id)
    res.status(200).json({
      patient_id: patient_id,
      url: urlFix(req.protocol + '://' + req.hostname + '/') + 'app/chart/' + patient_id
    })
  } else {
    res.status(200).json({response: 'Error connecting to database'})
  }
}

async function pinCheck (req, res, next) {
  if (process.env.INSTANCE === 'digitalocean' && process.env.NOSH_ROLE === 'patient') {
    const db = new PouchDB('pins', {skip_setup: true})
    var info = await db.info()
    if (objectPath.has(info, 'error')) {
      res.status(200).json({ response: 'Error', message: 'No PIN database exists'})
    }
    const result = await db.find({
      selector: {'_id': {$eq: req.body.patient}}
    })
    if (result.docs.length > 0) {
      res.status(200).json({ response: 'OK'})
    } else {
      res.status(200).json({ response: 'Error', message: 'PIN required' })
    }
  } else {
    res.status(200).json({ response: 'OK', message: 'PIN check not required'})
  }
}

async function pinClear (req, res, next) {
  const db = new PouchDB('pins', {skip_setup: true})
  var info = await db.info()
  if (!objectPath.has(info, 'error')) {
    if (req.body.patient == 'all') {
      await db.destroy()
      res.status(200).json({ response: 'OK', message: 'Cleared PIN database'})
    } else {
      try {
        const result = await db.get(req.body.patient)
        await db.remove(result)
        res.status(200).json({ response: 'OK', message: 'Cleared PIN entry'})
      } catch (e) {
        res.status(200).json({ response: 'OK', message: 'No PIN entry found'})
      }
    }
  } else {
    res.status(200).json({ response: 'OK', message: 'No PIN database exists'})
  }
}

async function pinSet (req, res, next) {
  const pindb = new PouchDB('pins')
  const test = await verifyPIN(req.body.pin, req.body.patient)
  if (test) {
    const pin1 = {
      _id: req.body.patient,
      pin: req.body.pin
    }
    await pindb.put(pin1)
    res.status(200).json({ response: 'OK' })
  } else {
    res.status(200).json({ response: 'Incorrect PIN' })
  }
}

async function addUser (req, res, next) {
  var name = 'elmo'
  var opts = {headers: { Authorization: `Bearer eyJhbGciOiJSUzI1NiJ9.eyJ2YyI6eyJAY29udGV4dCI6WyJodHRwczovL3d3dy53My5vcmcvMjAxOC9jcmVkZW50aWFscy92MSIsImh0dHBzOi8vd3d3LnczLm9yZy8yMDE4L2NyZWRlbnRpYWxzL2V4YW1wbGVzL3YxIl0sImlkIjoiaHR0cDovL2V4YW1wbGUuZWR1L2NyZWRlbnRpYWxzLzM3MzIiLCJ0eXBlIjpbIlZlcmlmaWFibGVDcmVkZW50aWFsIiwiVW5pdmVyc2l0eURlZ3JlZUNyZWRlbnRpYWwiXSwiaXNzdWVyIjoiaHR0cHM6Ly9leGFtcGxlLmVkdS9pc3N1ZXJzLzU2NTA0OSIsImlzc3VhbmNlRGF0ZSI6IjIwMTAtMDEtMDFUMDA6MDA6MDBaIiwiY3JlZGVudGlhbFN1YmplY3QiOnsiaWQiOiJkaWQ6ZXhhbXBsZTplYmZlYjFmNzEyZWJjNmYxYzI3NmUxMmVjMjEiLCJkZWdyZWUiOnsidHlwZSI6IkJhY2hlbG9yRGVncmVlIiwibmFtZSI6IkJhY2hlbG9yIG9mIFNjaWVuY2UgYW5kIEFydHMifX19LCJpYXQiOjE2NjA1Njc2MTIsImlzcyI6InVybjpleGFtcGxlOmlzc3VlciIsImF1ZCI6InVybjpleGFtcGxlOmF1ZGllbmNlIiwiZXhwIjoxNjYwNTc0ODEyLCJzdWIiOiJhZG1pbiJ9.GuAZkqMV3yctGivbp1FlMxPY3pI4SAfmVEnLT20iDvW3VsW-_ZoEm4RuU8s9Vh01tBekRs_wwtlGznE0v3XDs_Tg0tRgIcoy2m8lGU21_KOrWcwHPdZi8PmC3oM7gqpkZot-FFE6S6F78hlblhUiTOGrNuVSJaRKDKmcTTkAKsUTAA_8rywTgeYiIoiokNOHq7JE_YoPl_jddiEFxklHm2PWAI-qM21KX5gfH6gMGAWE_ksJuTzU2XQ32bya_jULVYyLyBmJdq6FBWjUupfHn72VBnWbQUu07a2T8t-9jDvl71CAmgfQGt9Ta3KwCIPoy1shT_C6A_3yoeh0k_VRew`}}
  var body = {
    "name": name,
    "password": "lalo37",
    "roles": ['write'],
    "type": "user"
    // "selector": {
    //     "_id": {"$gte": null}
    // },
    // // "fields": ["_id"],
    // "execution_stats": true
  }
  try {
    var result = await axios.put(settings.couchdb_uri + '/_users/org.couchdb.user:' + name, body, opts)
    console.log(result.status)
    res.status(200).json(result.data)
  } catch (e) {
    res.status(200).json(e)
  }
  // res.status(200).json(req.protocol + '://' + req.hostname + req.baseUrl + req.path)
}

async function test (req, res, next) {
  const key = {
    "_id": "nosh_e886ceff-48a1-49a3-8629-3e8235756320",
    "_rev": "1-ecb8b5fd1e37897e3ca6b5a740724cd6",
    "publicKey": {
      "kty": "RSA",
      "n": "nuxVvE1XvrFmKd49JYBqjsS4n315GLaXySB2CHv16lMtAUeyPWpdXStpznl0SM0DVuJN_LgZ3LFlKGyNrbsKK-YobG5gdmIKB-RuF-Dq_Go3-NGb_EcnGxMJ_PpcoUEmkZJKm1HsYYifv19NT4D2f0Lb0Z-AfWfSIrYj_WST4nRni-KLvCj35J1IOviWIrOsBgx2GnbKCe0YyHgu-AphYPDM4gPPiYym1SErOgVL9RFhFBYT2zZQiEfOR4pvsUqHYQwtxluKHlTTcGGZfZlNP3uFQNC3K69MKBcvfe6U7gyUJj5vsuHdvyoWCQdF0idIvsdH1DvYuwqdMEgKQabRDQ",
      "e": "AQAB",
      "kid": "c5fb7d75-846d-4757-9728-5af0528a8e57",
      "alg": "RS256"
    },
    "privateKey": {
      "kty": "RSA",
      "n": "nuxVvE1XvrFmKd49JYBqjsS4n315GLaXySB2CHv16lMtAUeyPWpdXStpznl0SM0DVuJN_LgZ3LFlKGyNrbsKK-YobG5gdmIKB-RuF-Dq_Go3-NGb_EcnGxMJ_PpcoUEmkZJKm1HsYYifv19NT4D2f0Lb0Z-AfWfSIrYj_WST4nRni-KLvCj35J1IOviWIrOsBgx2GnbKCe0YyHgu-AphYPDM4gPPiYym1SErOgVL9RFhFBYT2zZQiEfOR4pvsUqHYQwtxluKHlTTcGGZfZlNP3uFQNC3K69MKBcvfe6U7gyUJj5vsuHdvyoWCQdF0idIvsdH1DvYuwqdMEgKQabRDQ",
      "e": "AQAB",
      "d": "EjQ6IeauHV7OuA8H7ArIqe_owgQqYeVQf65jNteUNLIwXowq45QSe8CkTw1kf45USpiDnGYuODRtxPKiS_s30A1-JeWC0Syrv3mwDrYp1J4KKUtBVeWEmjpVE5BOGf6Pf29FcoMw039F5TLydR_tnGg5K8rcegDxdh5tAvKJahAC9HhU5oKBN1KdRljV903ZGac8s2bJBwUe9dJ7W_WxlSfrXwxv6BCzVcBD9uwVnj2_gYjwvfQIVBiE_TUsCPz69NwAjFbiBWnHiagLiFRS90oVgP94fVLwd8M1kNHp_yT7feViMzIw5uwXx1nCA-QidjDLs-g6hW6DDB1HivCKYQ",
      "p": "tghFub2DcI4_rfqAXEQyzRI81Oh80uMOTBqsUv_SZiPoXNBlJrXHYguvAUWYCZEICKnVbBC5i6VEEy_lkHVOrZscTBibFXmS6qw1ToLF9P-MIyVM9PpGjt800dFh51KNpb1y6vNoSdbVHU25v7OyazvQGrCzq1oRsgoFtcDmySU",
      "q": "34AolvhtIlWnwMD12Gb75TXAef2l7Lkx3xh8H64dQuzGZjbu75rVn6-lDZNwwNy1kQxJphbqonCb9QGKb2A7sMnk68uTbepdjNkOr7Pu9PWXlDMl3EmkA9EYvyKXsv5SnJqfHXgE2E-xmfuIIcUsdKwmwGYz5dhtxKCjZQjhZ8k",
      "dp": "hS2QNdBddd_c3yDDAL40nKyXLP3bNT9BmpR5N1BLUsc6nY0qNCQSd70skLWmAnnFcvEuYB3sYirLn24Pep0YrxMopNPrws5rmp3bclFjG1hL4vrLTwA81xKexlN2WZOgZn4wsYzb5An1abcQCx0hkCr2mlBlYxxGjgefHdbAArE",
      "dq": "hLYx4-thykh4UvGBSd1k56ayQv3Ff7o8DdAZLCqUP4AfEuS9nlMfVDHU3SnWgv7LZXSZauEitBAP2zzt-dJ3vzMzFnyMb3EB2beti9FZK-WE-0Af1B16IbYQbrZYw7VWUp1RrArvPY6c0-VS4VKWYjUy0X4ehPWtwFruivjp91k",
      "qi": "Pb_EO841raB7k3kSmMgoDgDW49-UGrzIF1y5WsCEnb0LLUNmZ70VHU2D32gMNNOFL95Sq3i7xOfpIlIquAVe2pJQJ01jebE4u2JMY_PSwKi8nPBkKeS76iXSOMb1nABYhaAO4WamV8uRpX3Md4Gpn12CD47O8XSA29MN92Hv4yo",
      "kid": "c5fb7d75-846d-4757-9728-5af0528a8e57",
      "alg": "RS256"
    }
  }
  const body = {
    "access_token": {
      "access": ["app"],
      "actions": ["read", "write"],
      "locations": [req.protocol + "://" + req.hostname + "/app/chart/1234"]
    },
    "client": {
      "display": {
        "name": "NOSH",
        "uri": req.protocol + "://" + req.hostname
      },
      "key": {
        "proof": "httpsig",
        "jwk": key.publicKey
      }
    },
    "interact": {
      "start": ["redirect"],
      "finish": {
        "method": "redirect",
        "uri": req.protocol + "://" + req.hostname + "/auth/gnapVerify",
        "nonce": crypto.randomBytes(16).toString('base64url')
      }
    }
  }
  const pre_headers = {
    "content-digest": "sha-256=:" + crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') + "=:",
    "content-length": JSON.stringify(body).length,
    "content-type": "application/json"
  }
  const headers = await signatureHeader({
    method: 'POST',
    url: urlFix(process.env.TRUSTEE_URL) + 'api/as/tx',
    headers: pre_headers,
    body: body
  },{
    components: [
      '@method',
      '@target-uri',
      'content-digest',
      'content-length',
      'content-type'
    ],
    parameters: {
      created: Math.floor(Date.now() / 1000),
      nonce: crypto.randomBytes(16).toString('base64url'),
      tag: "gnap",
      keyid: key.publicKey.kid,
      alg: 'rsa-v1_5-sha256'
    },
    key: key
  })
  const opts = {
    headers: headers
  }
  res.status(200).json(opts)
}

