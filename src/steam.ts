///<reference path="../node_modules/sinusbot/typings/global.d.ts" />

import type { Client } from "sinusbot/typings/interfaces/Client"

interface SteamResponse {
  steamid: string
  personaname: string
}

registerPlugin<{
  key: string
  command: string
}>({
  name: "Steam Authentication",
  engine: ">= 1.0.0",
  version: "1.0.0",
  description: "Library which handles Steam authentications",
  author: "Multivitamin <david.kartnaller@gmail.com",
  requiredModules: ["http"],
  vars: [{
    type: "string" as const,
    name: "key",
    title: "Steam API Key (visit https://steamcommunity.com/dev obtain one)",
    default: ""
  }, {
    type: "string" as const,
    name: "command",
    title: "Command to use (default: 'steam')",
    default: ""
  }]
}, (_, { key, command }) => {

  const engine = require("engine")
  const event = require("event")
  const store = require("store")
  const http = require("http")
  const DEFAULT_COMMAND_NAME = "steam"
  const STEAMID_REGEX = /^\d{17}$/
  const SHOWCASE_STEAMID = "76561198032854208"
  let commandName = "!steam"

  if (!key || key.length <= 0) throw new Error(`got an invalid steam key!`)

  event.on("load", () => {
    if (typeof command !== "string" || command.length < 1 || (/\s/).test(command)) {
      engine.log(`Invalid command name provided '${command}' using fallback name "${DEFAULT_COMMAND_NAME}"`)
      command = DEFAULT_COMMAND_NAME
    }

    const { createCommandGroup } = require("command")

    const cmd = createCommandGroup(command)
    commandName = cmd.getFullCommandName()
    cmd
      .help("get info about your steamid")
      .exec((invoker, {}, reply) => {
        const steamid = getSteamId(invoker)
        const challenge = getChallenge(invoker)
        if (!steamid && !challenge) {
          let message = `\nNo SteamId connected! Use the command "${commandName} set <steamId64>" to set a steamid`
          message += `\nTo find your steamid you can use this tool: [url]https://steamidfinder.com/[/url]`
          message += `\nNote: Your SteamID should look like: ${SHOWCASE_STEAMID}`
          return reply(message)
        } else if (!steamid && challenge) {
          reply(challengeMessage(challenge.challenge))
        } else {
          reply(`Your steamid is: ${steamid}`)
        }
      })
    cmd
      .addCommand("unset")
      .help("unsets your steamid and challenge from your account")
      .checkPermission(invoker => getSteamId(invoker) || getChallenge(invoker))
      .addArgument(arg => arg.string.setName("confirm").optional())
      .exec((invoker, { confirm }, reply) => {
        if (confirm.trim().toLowerCase() === "confirm") {
          unsetClient(invoker)
          reply(`Everything has been deleted!`)
        } else {
          reply(`To confirm that you really want to unbind your steamid please use "${commandName} unset confirm"`)
        }
      })
    cmd
      .addCommand("set")
      .help("sets your steamid")
      .checkPermission(invoker => !getSteamId(invoker))
      .addArgument(args => args.string.setName("steamid"))
      .exec((invoker, { steamid }, reply) => {
        if (!STEAMID_REGEX.test(steamid)) return reply(`Invalid SteamID provided! Your SteamID should look like that: ${SHOWCASE_STEAMID}`)
        reply(challengeMessage(createChallenge(invoker, steamid)))
      })
    cmd
      .addCommand("verify")
      .help("checks and verifies your steamid by your nickname")
      .checkPermission(invoker => !!getChallenge(invoker) && !getSteamId(invoker))
      .exec(async (invoker, _, reply) => {
        const challenge = getChallenge(invoker)
        if (!challenge) return reply("No challenge found")
        const data = await checkSteamId(challenge.steamid)
        if (data.steamid !== challenge.steamid) return reply(`Got an incorrect SteamID "${data.steamid}" does not equal "${challenge.steamid}"!`)
        if (data.personaname.toLowerCase().trim() !== challenge.challenge) {
          reply(`Your steam nickname "${data.personaname}" does not match "${challenge.challenge}"`)
          return reply(challengeMessage(challenge.challenge))
        }
        unsetClient(invoker)
        setSteamId(invoker, challenge.steamid)
        reply(`Success! Your SteamID has been set to ${challenge.steamid}!`)
      })
  })

  function checkSteamId(steamid: string): Promise<SteamResponse> {
    return new Promise((fulfill, reject) => {
      http.simpleRequest({
        url: `http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${steamid}&json=1`
      }, (err, res) => {
        if (err) return reject(new Error(err))
        if (res.statusCode !== 200) return reject(new Error(`got a non 200 status code from steam api! (code: ${res.statusCode})`))
        return fulfill(JSON.parse(res.data.toString()).response.players[0])
      })
      
    })
  }

  /**
   * creates the instruction message on how to verify your steamid
   * @param command command name
   * @param challenge challenge string
   */
  function challengeMessage(challenge: string) {
    let message = `\nTo complete the steam verification challenge please set your steam nickname to ${challenge} and use the command "${commandName} verify"`
    message += `\nAfterwards you can change your nickname back!"`
    return message
  }

  /**
   * creates a random string
   * @param len length of the string
   */
  function randomString(len: number = 12) {
    const chars = "abcdefghijklmopqrstuvwxyz0123456789"
    return new Array(len).fill(null).map(() => chars[Math.floor(Math.random() * chars.length)]).join("")
  }

  /**
   * creates a new nickname challenge for the given client
   * @param client steamid to create the challenge for
   * @returns returns the challenge string
   */
  function createChallenge(client: Client|string, steamid: string) {
    const challenge = randomString()
    setChallenge(client, challenge, steamid)
    return challenge
  }

  /**
   * sets the challenge of a client
   * @param client the client object or uid
   * @param steamid id which should be stored
   */
  function setChallenge(client: Client|string, challenge: string, steamid: string) {
    return store.setInstance(getChallengeNamespace(client), { challenge, steamid })
  }

  /**
   * retrieves the challenge of a teamspeak client
   * @param client the client object or uid
   */
  function getChallenge(client: Client|string): { challenge: string, steamid: string }|undefined {
    return store.getInstance(getChallengeNamespace(client))
  }

  /**
   * sets the steamid of a client
   * @param client the client object or uid
   * @param steamid id which should be stored
   */
  function setSteamId(client: Client|string, steamid: string) {
    return store.setInstance(getSteamIdNamespace(client), steamid)
  }

  /**
   * retrieves the steamid of a teamspeak client
   * @param client the client object or uid
   */
  function getSteamId(client: Client|string) {
    return store.getInstance(getSteamIdNamespace(client))
  }

  /**
   * unsets all properties from a client from the databsae
   * @param client client object or uid
   */
  function unsetClient(client: Client|string) {
    store.unsetInstance(getSteamIdNamespace(client))
    store.unsetInstance(getChallengeNamespace(client))
  }

  function getSteamIdNamespace(client: Client|string) {
    return `steamid_${typeof client === "string" ? client : client.uid()}`
  }

  /** extracts the uid from the steamid namespace */
  function getUidFromSteamIdNamespace(namespace: string) {
    return namespace.substr(8)
  }

  function getChallengeNamespace(client: Client|string) {
    return `steamChallenge_${typeof client === "string" ? client : client.uid()}`
  }

  function getUidFromSteamId(steamid: string): string|undefined {
    const keys = store.getKeysInstance()
    const key = keys.find(key => store.getInstance(key) === steamid)
    if (!key) return
    return getUidFromSteamIdNamespace(key)
  }

  module.exports = {
    setSteamId,
    getSteamId,
    getUidFromSteamId,
    getCommandName: () => commandName
  }
}) 