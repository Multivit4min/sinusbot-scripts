///<reference path="node_modules/sinusbot/typings/global.d.ts" />

import type { Client } from "sinusbot/typings/interfaces/Client"

registerPlugin<{
  commandName: string
  sendNotifyMessage: number
  notifyMessage: string
  groups: {
    age: number
    group: number
  }[]
}>({
  name: "Age Groups",
  description: "checks the age of a client and assigns a group",
  version: "1.0.0",
  author: "Multivitamin <david.kartnaller@gmail.com>",
  backends: ["ts3", "discord"],
  vars: [{
    type: "string" as const,
    name: "commandName",
    title: "Command Name which should be used (default: 'dob')",
    default: "dob"
  }, {
    type: "select" as const,
    name: "sendNotifyMessage",
    title: "Send a notification if no date of birth has been set? (default: false)",
    default: "0",
    options: ["No", "Yes"]
  }, {
    type: "string" as const,
    name: "notifyMessage",
    title: "The message which should get sent",
    indent: 2,
    default: "",
    conditions: [{
      field: "sendNotifyMessage",
      value: 1
    }]
  }, {
    type: "array" as const,
    name: "groups",
    title: "Groups for specific ages",
    default: [],
    vars: [{
      type: "number" as const,
      name: "age",
      title: "Age in years",
      indent: 2,
      default: 0
    }, {
      type: "number" as const,
      name: "group",
      title: "ServerGroup",
      indent: 2,
      default: 0,
    }]
  }]
}, (_, { groups, sendNotifyMessage, notifyMessage, commandName }) => {

  const sortedGroups = groups.sort((g1, g2) => g1.age - g2.age).reverse()
  const availableGroups = groups.map(g => g.group)

  const engine = require("engine")
  const store = require("store")
  const event = require("event")
  const format = require("format")
  const backend = require("backend")
  const regex = (/(0?[1-9]|[1-2][0-9]|3[0-1])[\.-](0?[1-9]|1[0-2])[\.-](\d{4})/)
  const MINIMUM_SAFE_AGE = 8

  type DoB = [number, number, number];
  enum GroupResponseCodes {
    OK = 0,
    CLIENT_NOT_IN_STORE = 1,
    CLIENT_MINIMUM_AGE_FOR_GROUP = 2

  }

  executeAtMidnight(() => validateOnline())
  event.on("connect", () => validateOnline())
  event.on("clientMove", ev => !ev.fromChannel && onClientConnect(ev.client))
  event.on("serverGroupAdded", ev => !ev.invoker.isSelf() && validateGroup(ev.client))
  event.on("serverGroupRemoved", ev => !ev.invoker.isSelf() && validateGroup(ev.client))

  event.on("load", () => {
    const command = require("command")
    const { createCommand, createArgument } = command

    if (typeof commandName !== "string" || commandName.length < 1 || (/\s/).test(commandName)) {
      engine.log(`Invalid command name provided '${commandName}' using fallback name "dob"`)
      commandName = "dob"
    }

    createCommand(commandName)
      .help(`sets your personal ${format.bold("d")}ate ${format.bold("o")}f ${format.bold("b")}irth`)
      .manual("sets your date of birth and gives you a group")
      .manual("enter your age in format 'dd.mm.yyyy' or 'dd-mm-yyyy'")
      .manual("when using this command your teamspeak uid and age will get saved to a database")
      .addArgument(createArgument("string").setName("dob").match(regex).optional())
      .exec((invoker, { dob }: { dob?: string }, reply) => {
        if (!dob) {
          const stored = fetch(invoker.uid())
          if (!stored) return reply(`You do not have set any group!`)
          return reply(`Your birthday is set on ${format.bold(stored.join("."))} and your age is ${format.bold(String(getAge(stored)))}!`)
        }
        const match = <RegExpMatchArray>dob.match(regex)
        const dateofbirth: DoB = [ parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)]
        if (getAge(dateofbirth) < MINIMUM_SAFE_AGE) return reply("this does not look like a valid age!")
        persist(invoker.uid(), dateofbirth)
        const response = validateGroup(invoker)
        switch (response) {
          case GroupResponseCodes.OK:
            return reply("all done!")
          case GroupResponseCodes.CLIENT_NOT_IN_STORE:
            return reply("uh oh, something went wrong while saving to store")
          case GroupResponseCodes.CLIENT_MINIMUM_AGE_FOR_GROUP:
            return reply("age has been saved but there is not group to assign to you")
          default:
            return reply(`got an invalid response! response was: '${response}'`)
        }
      })
  })

  /** sends a chat message if enabled to the client to request age verification */
  function onClientConnect(client: Client) {
    if (sendNotifyMessage && validateGroup(client) === GroupResponseCodes.CLIENT_NOT_IN_STORE) {
      client.chat(notifyMessage)
    }
  }

  /**
   * persists uid and date of birth to store
   * @param uid uid of the client
   * @param dob date of birth of the client
   */
  function persist(uid: string, dob: DoB) {
    store.setInstance(`dob_${uid}`, dob)
  }

  /**
   * tries to retrieve the date of birth of a client
   * @param uid client which dob should get retrieved
   */
  function fetch(uid: string): DoB|undefined {
    return store.getInstance(`dob_${uid}`)
  }

  /**
   * validates the group of a client
   * @param uid the uid of the client
   */
  function validateGroup(client: Client) {
    const dob = fetch(client.uid())
    if (!dob) {
      whiteListGroup(client, [], availableGroups)
      return GroupResponseCodes.CLIENT_NOT_IN_STORE
    }
    const age = getAge(dob)
    const group = getGroupFromAge(age)
    if (group === -1) return GroupResponseCodes.CLIENT_MINIMUM_AGE_FOR_GROUP
    whiteListGroup(client, [group], availableGroups)
    return GroupResponseCodes.OK
  }

  /** checks the groups of all online clients */
  function validateOnline() {
    const saved = getSavedUids()
    backend.getClients()
      .filter(c => saved.includes(c.uid()))
      .forEach(c => validateGroup(c))
  }

  /**
   * returns the age as number
   * @param dob the birth date
   */
  function getAge([day, month, year]: DoB) {
    const date = new Date()
    const cd = date.getDate()
    const cm = date.getMonth() + 1
    const cy = date.getFullYear()
    let age = cy - year - 1
    if (cm > month) {
      age += 1
    } else if (cm === month && cd >= day) {
      age += 1
    }
    return age
  }

  /**
   * adds a set of groups to a client and removes groups he should not be in
   * @param client the client to add/remove groups from
   * @param group the groups a client can have
   * @param whitelisted whitelisted groups
   */
  function whiteListGroup(client: Client, groups: (number|string)[], whitelisted: (number|string)[]) {
    let assign = groups.map(g => String(g))
    const remove = whitelisted.map(w => String(w)).filter(w => !assign.includes(w))
    client.getServerGroups()
      .forEach(group => {
        if (remove.includes(group.id())) {
          client.removeFromServerGroup(group.id())
        } else if (assign.includes(group.id())) {
          assign.splice(assign.indexOf(group.id()), 1)
        }
      })
    assign.forEach(g => client.addToServerGroup(g))
  }

  /**
   * retrieves the servergroup the age should have
   * @param age the age to check
   */
  function getGroupFromAge(age: number) {
    let g = sortedGroups.find(g => g.age <= age)
    if (!g) {
      if (sortedGroups.length === 0 || sortedGroups[0].age > age) {
        g = { age: -1, group: -1 }
      } else {
        g = sortedGroups[sortedGroups.length - 1]
      }
    }
    return g.group
  }

  /**
   * tries to retrieve the age of a client
   * if the client has not been saved to database then it returns false
   * otherwiese returns a number which represents the age of the client
   * @param uid the client uid to retrieve
   */
  function getAgeOfClient(uid: string) {
    const dob = fetch(uid)
    if (!dob) return false
    return getAge(dob)
  }

  /**
   * retrieves all uids which have a saved date of birth in the database
   */
  function getSavedUids(): string[] {
    return store.getKeysInstance()
      .filter(key => key.match(/^dob_.*$/))
      .map(key => key.match(/^dob_(.*)$/)[1])
  }

  /**
   * starts a job every day at midnight
   * @param cb callback to execute
   */
  function executeAtMidnight(cb: () => void) {
    const date = new Date()
    date.setMilliseconds(0)
    date.setSeconds(5)
    date.setMinutes(0)
    date.setHours(0)
    date.setDate(date.getDate() + 1)
    setTimeout(() => {
      try {
        cb()
      } catch (e) {
        executeAtMidnight(cb)
        throw e
      }
      executeAtMidnight(cb)
    }, date.getTime() - Date.now())
  }

  module.exports = {
    getAgeOfClient,
    getSavedUids
  }

})