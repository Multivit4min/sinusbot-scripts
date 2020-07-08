///<reference path="../node_modules/sinusbot/typings/global.d.ts" />

import type { Event } from "sinusbot/typings/modules/event"
import type { Client } from "sinusbot/typings/interfaces/Client"

interface Config {
  cid: string
  allowed: string[]
  protected: string[]
  addJailOnMove: string
  moveAllowAll: string
  moveTime: number
  onServerGroup: string
  serverGroup: number
  groupAddAutojail: string
  groupAllowAll: string
  groupTime: number
  jailOnRecord: string
  recordMode: string
  recordTime: number
}

registerPlugin<Config>({
  name: "Jail",
  engine: ">= 1.0.0",
  version: "2.1.3",
  description: "allows you to lock in people in a defined channel",
  author: "Multivitamin <david.kartnaller@gmail.com",
  backends: ["ts3"],
  vars: [{
    name: "cid",
    title: "Channel to move jailed Clients",
    type: "channel" as const,
    default: ""
  }, {
    name: "allowed",
    title: "List of Group IDs which are allowed to Jail Clients",
    type: "strings" as const,
    default: []
  }, {
    name: "protected",
    title: "List of Group IDs which are not able to get Jailed.",
    type: "strings" as const,
    default: []
  }, {
    name: "addJailOnMove",
    title: "Add a User to jail if he gets moved into the jail channel?",
    type: "select" as const,
    options: ["no", "yes"],
    default: "0"
  }, {
    name: "moveAllowAll",
    title: "Should everyone who can move the user to the jail channel be able to jail the client?",
    type: "select" as const,
    options: ["no", "yes"],
    default: "0",
    indent: 2,
    conditions: [{ field: "addJailOnMove", value: 1 }]
  }, {
    name: "moveTime",
    title: "Jail Time when a User gets moved into Jail (0 = Permanent / in Seconds)",
    type: "number" as const,
    default: 0,
    indent: 2,
    conditions: [{ field: "addJailOnMove", value: 1 }]
  }, {
    name: "onServerGroup",
    title: "Add User to specified Group if they are getting jailed",
    type: "select" as const,
    options: ["no", "yes"],
    default: "0"
  }, {
    name: "serverGroup",
    title: "Group ID of Servergroup which should be added to the jailed User",
    type: "number" as const,
    default: 0,
    indent: 2,
    conditions: [{ field: "onServerGroup", value: 1 }]
  }, {
    name: "groupAddAutojail",
    title: "Jail User if he gets added manually to the Jail Server Group?",
    type: "select" as const,
    options: ["no", "yes"],
    default: "0",
    indent: 2,
    conditions: [
      { field: "onServerGroup", value: 1 }
    ]
  }, {
    name: "groupAllowAll",
    title: "Should everyone who can add the Group to the User be able to use Jail with Group assign?",
    type: "select" as const,
    options: ["no", "yes"],
    default: "0",
    indent: 4,
    conditions: [{ field: "onServerGroup", value: 1 }, { field: "groupAddAutojail", value: 1 }]
  }, {
    name: "groupTime",
    title: "Jail Time when User gets added to the Group (0 = Permanent / in Seconds)",
    type: "number" as const,
    default: 0,
    indent: 4,
    conditions: [{ field: "onServerGroup", value: 1 }, { field: "groupAddAutojail", value: 1 }]
  }, {
    name: "jailOnRecord",
    title: "Jail Client if he starts recording",
    type: "select" as const,
    options: ["no", "yes"],
    default: "0"
  }, {
    name: "recordMode",
    title: "Remove from jail when he stops recording?",
    type: "select" as const,
    options: ["no", "yes"],
    default: "0",
    indent: 2,
    conditions: [{ field: "jailOnRecord", value: 1 }]
  }, {
    name: "recordTime",
    title: "Jail Time when User starts recording (0 = Permanent / in Seconds)",
    type: "number" as const,
    default: 0,
    indent: 4,
    conditions: [{ field: "jailOnRecord", value: 1 }, { field: "recordMode", value: 0 }]
  }]
}, (_, config) => {

  const engine = require("engine")
  const backend = require("backend")
  const event = require("event")
  const store = require("store")

  let initialized = false

  const TIME_SUFFIX = {
    "sec": 1000,
    "second": 1000,
    "min": 60 * 1000,
    "minute": 60 * 1000,
    "hour": 60 * 60 * 1000,
    "day": 24 * 60 * 60 * 1000
  }

  const timesuffixes = Object.keys(TIME_SUFFIX).reduce((acc, curr) => {
    acc.push(curr, `${curr}s`)
    return acc
  }, [] as string[])

  type JailConfig = Config & { namespace: string }

  class Jail {
    
    prisoners: Prisoner[] = []
    readonly config: JailConfig

    constructor(config: JailConfig) {
      this.config = config
      this.init()
    }

    private init() {
      this.getChannel()
      const data = store.getInstance(this.getStoreName())
      if (Array.isArray(data)) {
        this.prisoners = data.map(d => {
          const prisoner = new Prisoner(this)
          prisoner.deserialize(d)
          return prisoner
        })
      }
      event.on("clientMove", ev => this.onClientMove(ev))
      if (this.config.onServerGroup === "1" && this.config.groupAddAutojail === "1") {
        event.on("serverGroupAdded", ev => this.onServerGroupAdded(ev))
        event.on("serverGroupRemoved", ev => this.onServerGroupRemoved(ev))
      }
      if (this.config.jailOnRecord === "1") {
        event.on("clientRecord", ev => this.onRecord(ev))
        if (this.config.recordMode === "1") {
          event.on("clientRecordStop", ev => this.onRecordStop(ev))
        }
      }
      setInterval(() => this.checkAll(), 10 * 1000)
      this.checkAll()
    }

    onClientMove({ fromChannel, toChannel, client, invoker }: Event.clientMoveEvent) {
      if (!toChannel || !invoker) return
      if (toChannel.equals(this.getChannel())) {
        if (this.config.addJailOnMove === "0") return
        if (this.config.moveAllowAll !== "1" && !this.allowCommand(invoker)) return
        if (this.isProtected(client)) return
        if (invoker.isSelf()) return
        this.add(client, this.config.moveTime * 1000)
        invoker.chat(`You jailed [URL=${client.getURL()}]${client.nick()}[/URL]!`)
      } else if (fromChannel && fromChannel.equals(this.getChannel())) {
        if (this.config.addJailOnMove === "0") return
        if (this.config.moveAllowAll !== "1" && !this.allowCommand(invoker)) return this.check(client)
        const prisoner = this.getPrisonerByUid(client.uid())
        if (!prisoner) return
        this.release(prisoner, PrisonerMode.MOVEOUT)
      } else {
        this.check(client)
      }
    }

    onRecord(client: Client) {
      if (this.isProtected(client)) return
      if (this.isPrisoner(client)) return
      if (this.config.recordMode === "1") {
        this.add(client, 0).addReleaseMode(PrisonerMode.STOPRECORD)
      } else {
        this.add(client, this.config.recordTime * 1000)
      }
    }

    onRecordStop(client: Client) {
      const prisoner = this.getPrisonerByUid(client.uid())
      if (!prisoner) return
      this.release(prisoner, PrisonerMode.STOPRECORD)
    }

    onServerGroupRemoved({ invoker, client, serverGroup }: Event.clientServerGroupEvent) {
      if (invoker.isSelf() || serverGroup.id() !== this.getServerGroup().id() || !this.isPrisoner(client)) return
      if (this.allowServerGroupAssign(invoker)) {
        this.release(this.getPrisonerByUid(client.uid())!, PrisonerMode.REVOKEGROUP)
      } else {
        client.chat("You are not allowed to remove this group!")
        client.addToServerGroup(serverGroup)
      }
    }

    onServerGroupAdded({ invoker, client, serverGroup }: Event.clientServerGroupEvent) {
      if (invoker.isSelf() || serverGroup.id() !== this.getServerGroup().id()) return
      if (!this.allowServerGroupAssign(invoker)) {
        client.chat("You are not allowed to assign this group!")
        client.removeFromServerGroup(serverGroup)
      } else if (this.isProtected(client)) {
        client.chat("This user is protected!")
        client.removeFromServerGroup(serverGroup)
      } else {
        this.add(client, this.config.groupTime * 1000)
      }
    }

    getChannel() {
      if (this.config.cid === "0") throw new Error("No Jail Channel defined")
      const channel = backend.getChannelByID(this.config.cid)
      if (!channel) throw new Error("Jail channel not found! (has it been deleted?)")
      return channel
    }

    getServerGroup() {
      const group = backend.getServerGroups().find(g => g.id() === String(this.config.serverGroup))
      if (!group) throw new Error(`could not find group with id ${this.config.serverGroup}`)
      return group
    }

    isProtected(client: Client) {
      return client.getServerGroups().some(g => this.config.protected.includes(g.id()))
    }

    allowCommand(client: Client) {
      return client.getServerGroups().some(g => this.config.allowed.includes(g.id()))
    }

    allowServerGroupAssign(client: Client) {
      return this.config.groupAllowAll === "1" || this.allowCommand(client)
    }

    add(client: Client, duration: number = 0) {
      let prisoner = this.getPrisonerByUid(client.uid())
      if (!prisoner) {
        prisoner = new Prisoner(this, client)
        this.prisoners.push(prisoner)
      }
      prisoner.setDuration(duration)
      this.check(client)
      this.save()
      return prisoner
    }

    isPrisoner(client: Client) {
      return this.prisoners.map(p => p.uid).includes(client.uid())
    }

    checkAll() {
      const uids = this.prisoners.map(({ uid }) => uid)
      backend.getClients()
        .filter(c => uids.includes(c.uid()))
        .forEach(c => this.check(c))
    }

    check(client: Client) {
      if (!this.isPrisoner(client)) return false
      const prisoner = this.getPrisonerByUid(client.uid())!
      if (prisoner.shouldGetReleased())
        return this.release(prisoner, PrisonerMode.TIMEUP)
      if (client.getAudioChannel().id() !== this.getChannel().id()) {
        client.chat("You can not run away from justice!")
        client.moveTo(this.getChannel())
      }
      if (this.config.onServerGroup === "1") {
        const group = this.getServerGroup()
        if (!client.getServerGroups().some(g => g.id() === group.id())) {
          client.addToServerGroup(group)
        }
      }
    }

    release(prisoner: Prisoner, mode: PrisonerMode) {
      if (!(prisoner instanceof Prisoner)) throw new Error("Invalid Prisoner Object")
      if (!prisoner.hasReleaseMode(mode)) return engine.log(`Will not release, no release mode named ${mode}`)
      const client = backend.getClientByUID(prisoner.uid)
      if (client) {
        if (client.getAudioChannel().equals(this.getChannel())) {
          client.kickFromChannel("You have been released from jail!")
        } else {
          client.chat("You have been released from jail!")
        }
        const group = this.getServerGroup()
        if (this.config.onServerGroup === "1" && client.getServerGroups().some(g => g.id() === group.id())) {
          client.removeFromServerGroup(group)
        }
      }
      this.prisoners = this.prisoners.filter(p => p.uid !== prisoner.uid)
      this.save()
    }

    getPrisonerByUid(uid: string) {
      return this.prisoners.find(p => p.uid === uid)
    }

    private getStoreName() {
      return `${this.config.namespace}prisoners`
    }

    save() {
      store.setInstance(this.getStoreName(), this.prisoners.map(p => p.serialize()))
    }
  }

  enum PrisonerMode {
    STOPRECORD,
    TIMEUP,
    REVOKEGROUP,
    MOVEOUT,
    COMMAND
  }

  class Prisoner {

    private jail: Jail
    private releaseMode: PrisonerMode[] = []
    private release: number = 0
    uid!: string
    nick!: string
    static MODE = {
    }
  
    constructor(jail: Jail, client?: Client) {
      this.jail = jail
      if (client) this.init(client)
    }

    private init(client: Client) {
      this.uid = client.uid()
      this.nick = client.nick()
      this.releaseMode = [
        PrisonerMode.TIMEUP,
        PrisonerMode.REVOKEGROUP,
        PrisonerMode.MOVEOUT,
        PrisonerMode.COMMAND
      ]
    }

    addReleaseMode(mode: PrisonerMode) {
      this.releaseMode.push(mode)
      return this
    }

    hasReleaseMode(mode: PrisonerMode) {
      return this.releaseMode.includes(mode)
    }

    setDuration(duration: number) {
      if (duration === 0) {
        this.release = 0
      } else {
        this.release = Date.now() + duration
      }
      return this
    }

    addDuration(duration: number) {
      if (duration === 0) {
        this.release = 0
      } else {
        this.release += duration
      }
      return this
    }

    url() {
      return `[URL=client://0/${this.uid}~${encodeURI(this.nick)}]${this.nick}[/URL]`
    }

    private calcTime(dividend: number, divisor: number, modulo: number = 0, suffix: string = "") {
      let time = Math.floor(dividend / divisor)
      if (time < 0) time = 0
      if (modulo > 0) time %= modulo
      return `${time} ${suffix}${(!suffix || time === 1) ? "" : "s"}`
    }

    secondsTillRelease() {
      return Math.floor((this.release - Date.now()) / 1000)
    }

    duration() {
      if (this.release === 0) return "PERMANENT"
      return [this.getDays(), this.getHours(), this.getMinutes(), this.getSeconds()].join(" ")
    }

    getDays() {
      return this.calcTime(this.secondsTillRelease(), 24 * 60 * 60, -1, "day")
    }

    getHours() {
      return this.calcTime(this.secondsTillRelease(), 60 * 60, 24, "hour")
    }

    getMinutes() {
      return this.calcTime(this.secondsTillRelease(), 60, 60, "minute")
    }

    getSeconds() {
      return this.calcTime(this.secondsTillRelease(), 1, 60, "second")
    }

    shouldGetReleased() {
      return (
        this.release <= Date.now() &&
        this.release !== 0 && (
          this.jail.config.jailOnRecord === "0" ||
          !this.isRecording()
        )
      )
    }

    isRecording() {
      const client = backend.getClientByUID(this.uid)
      if (!client) return false
      return client.isRecording()
    }

    serialize() {
      return {
        uid: this.uid,
        nick: this.nick,
        release: this.release,
        releasemode: this.releaseMode
      }
    }

    deserialize(data: Record<string, any>) {
      this.uid = data.uid
      this.nick = data.nick
      this.release = data.release
      this.releaseMode = data.releasemode
      return this
    }
  }

  
  const jail = new Jail({ namespace: "jail_", ...config })

  event.on("load", () => {
    if (backend.isConnected()) return initialize()
    event.on("connect", initialize)
  })

  function initialize() {
    if (initialized) return
    initialized = true

    const Command = require("command")
    if (!Command) return engine.log("command.js not found! Please be sure to install and enable command.js")
    const { createCommandGroup, createArgument, createGroupedArgument } = Command

    const jailCommand = createCommandGroup("jail")

    jailCommand
      .help("manages a jail")

    jailCommand
      .addCommand("add")
      .help("adds a client to the jail")
      .manual("adds a new client to the jail")
      .checkPermission(jail.allowCommand.bind(jail))
      .addArgument(createArgument("client").setName("client"))
      .addArgument(
        createGroupedArgument("and").setName("duration", "<duration> <min|hour|day>")
          .addArgument(createArgument("number").setName("time").min(1))
          .addArgument(createArgument("string").setName("suffix").whitelist(timesuffixes).forceLowerCase())
          .optional(false, false)
      )
      .exec((issuer, { client, duration }, reply) => {
        const target = backend.getClientByUID(client)
        if (!target) return reply(`Target Client with uid ${client} not found!`)
        if (jail.isProtected(target)) return reply("Client you want to jail is protected!")
        let jailDuration = 0
        //@ts-ignore
        if (duration) jailDuration = duration.time * TIME_SUFFIX[duration.suffix.match(/^(.*?)s?$/)[1]]
        const prisoner = jail.add(target, jailDuration)
        if (jailDuration === 0) {
          target.chat(`You have been sentenced for live in prison by [URL=${issuer.getURL()}]${issuer.nick()}[/URL]`)
          issuer.chat(`You have sentenced ${prisoner.url()} for live in prison!`)
        } else {
          target.chat(`You have been sentenced for ${duration.time} ${duration.suffix} prison by [URL=${issuer.getURL()}]${issuer.nick()}[/URL]`)
          issuer.chat(`You have sentenced ${prisoner.url()} for  ${duration.time} ${duration.suffix} in prison!`)
        }
      })

    jailCommand
      .addCommand("release")
      .help("removes a client from jail")
      .checkPermission(jail.allowCommand.bind(jail))
      .addArgument(createArgument("client").setName("client"))
      .exec((issuer, { client }, reply) => {
        const prisoner = jail.getPrisonerByUid(client)
        if (!prisoner) return reply("This client is not a prisoner!")
        jail.release(prisoner, PrisonerMode.COMMAND)
        reply("Client has been released!")
      })

    jailCommand
      .addCommand("list")
      .help("lists all jailed clients")
      .exec((issuer, args, reply) => {
        const count = jail.prisoners.length
        reply(`There ${count === 1 ? "is" : "are" } [b]${count}[/b] prisoner${count === 1 ? "" : "s"}!`)
        jail.prisoners.forEach(p => reply(`${p.url()} - ${p.duration()}`))
      })

    event.on("unload", () => jail.save())
  }


  module.exports = {
    jail
  }

})