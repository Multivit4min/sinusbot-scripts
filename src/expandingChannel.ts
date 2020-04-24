///<reference path="../node_modules/sinusbot/typings/global.d.ts" />

import type { Channel, ChannelCreateParams } from "sinusbot/typings/interfaces/Channel"

/**
 * Changelog 1.1.0:
 * fix invoker undefined when temporary channel gets deleted
 * add support for roman numerals
 * add support for permission i_channel_needed_join_power
 * Changelog 1.2.0:
 * add support of setting description and topic
 * add support of setting custom permisisons
 * removed joinPower setting
 */

interface Config {
  channels: ChannelConfig[]
}

type PermissionConfig = PermissionConfigEntry[]
interface PermissionConfigEntry {
  name: string
  value: number
  skip: boolean
  negate: boolean
}

interface ChannelConfig {
  parent: string
  name: string
  minfree: number
  deleteDelay: number
  codec: string
  quality: string
  talkpower: number
  maxClients: number
  numerals: string
  joinpower: number
  description: string
  topic: string
  permissions: PermissionConfig
}

registerPlugin<Config>({
  name: "Expanding Channels",
  engine: ">= 1.0.0",
  version: "1.2.0",
  description: "automatic channel creation tool based on need",
  author: "Multivitamin <david.kartnaller@gmail.com",
  backends: ["ts3"],
  vars: [{
    type: "array" as const,
    name: "channels",
    title: "Channels",
    default: [],
    vars: [{
      type: "channel" as const,
      name: "parent",
      title: "Parent Channel",
      default: "0"
    }, {
      type: "string" as const,
      name: "name",
      title: "Channel Name, use % to indicate the position of the number eg ('Talk %' gets converted to 'Talk 1')",
      default: ""
    }, {
      type: "number" as const,
      name: "minfree",
      title: "Minimum amount of free channels to generate (defaults to 1)",
      default: 1
    }, {
      type: "number" as const,
      name: "deleteDelay",
      title: "Delay in seconds till the channel gets deleted after someone left (0 to disable)",
      default: 0
    }, {
      type: "select" as const,
      name: "codec",
      title: "Audio codec to use for the channel",
      options: ["Opus Voice", "Opus Music"],
      default: "0"
    }, {
      type: "select" as const,
      name: "quality",
      title: "Codec Quality to use for the channel",
      options: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
      default: "9"
    }, {
      type: "number" as const,
      name: "talkpower",
      title: "required talkpower (0 to disable)",
      default: 0
    }, {
      type: "number" as const,
      name: "maxClients",
      title: "maximum clients which are able to enter (-1 to disable)",
      default: -1
    }, {
      type: "number" as const,
      name: "joinpower",
      title: "required channel join power (0 to disable)",
      default: 0
    }, {
      type: "string" as const,
      name: "topic",
      title: "Channel Topic to set",
      default: ""
    }, {
      type: "multiline" as const,
      name: "description",
      title: "Channel description:",
      default: ""
    }, {
      type: "select" as const,
      name: "numerals",
      title: "Use Romand or Decimal numbers to show the channel count",
      options: ["Decimal", "Roman"],
      default: "0"
    }, {
      type: "array" as const,
      name: "permissions",
      title: "Set Custom Permissions",
      vars: [{
        type: "string" as const,
        name: "name",
        title: "Permission name (eg 'b_channel_create_child')",
        default: "__INVALID__",
      }, {
        type: "number" as const,
        name: "value",
        title: "Permission value",
        default: 0,
      }, {
        type: "checkbox" as const,
        name: "skip",
        title: "Set skip flag?",
        default: false,
      }, {
        type: "checkbox" as const,
        name: "negate",
        title: "Set negate flag?",
        default: false,
      }],
      default: []
    }]
  }]
}, (_, { channels }) => {

  const event = require("event")
  const backend = require("backend")


  class Roman {

    static upToTen(num: number, one: string, five: string, ten: string) {
      let value = ""
      switch (num) {
        case 0: return value
        case 9: return one + ten
        case 4: return one + five
      }
      if (num >= 5) value = five, num -= 5
      while (num-- > 0) value += one
      return value
    }

    static isValid(roman: string) {
      return (/^(M{0,3})(CM|DC{0,3}|CD|C{0,3})(XC|LX{0,3}|XL|X{0,3})(IX|VI{0,3}|IV|I{0,3})$/).test(roman.toUpperCase())
    }

    static toRoman(arabic: number) {
      arabic = Math.floor(arabic)
      if (arabic < 0) throw new Error("toRoman cannot express negative numbers")
      if (arabic > 3999) throw new Error("toRoman cannot express numbers over 3999")
      if (arabic === 0) return "nulla"
      let roman = ""
      roman += Roman.upToTen(Math.floor(arabic / 1000), "M", "", ""), arabic %= 1000
      roman += Roman.upToTen(Math.floor(arabic / 100), "C", "D", "M"), arabic %= 100
      roman += Roman.upToTen(Math.floor(arabic / 10), "X", "L", "C"), arabic %= 10
      roman += Roman.upToTen(arabic, "I", "V", "X")
      return roman
    }

    static toArabic(roman: string) {
      if (/^nulla$/i.test(roman) || !roman.length) return 0
      const match = roman.toUpperCase().match(/^(M{0,3})(CM|DC{0,3}|CD|C{0,3})(XC|LX{0,3}|XL|X{0,3})(IX|VI{0,3}|IV|I{0,3})$/)
      if (!match) throw new Error("toArabic expects a valid roman number")
      let arabic = 0
      arabic += match[1].length * 1000
      if (match[2] === "CM") {
        arabic += 900
      } else if (match[2] === "CD") {
        arabic += 400
      } else {
        arabic += match[2].length * 100 + (match[2][0] === "D" ? 400 : 0)
      }
      if (match[3] === "XC")  {
        arabic += 90
      } else if (match[3] === "XL") {
        arabic += 40
      } else {
        arabic += match[3].length * 10 + (match[3][0] === "L" ? 40 : 0)
      }
      if (match[4] === "IX") {
        arabic += 9
      } else if (match[4] === "IV") {
        arabic += 4
      } else {
        arabic += match[4].length * 1 + (match[4][0] === "V" ? 4 : 0)
      }
      return arabic
    }
  }

  enum ExpandingChannelNumeral {
    DECIMAL = "0",
    ROMAN = "1"
  }

  interface ExpandingChannelConfig {
    name: string
    parent: Channel
    minimumFree: number
    regex: RegExp
    deleteDelay: number
    channelOpts: Omit<ChannelCreateParams, "name"|"parent">
    numeralMode: ExpandingChannelNumeral
    permissions: PermissionConfig
  }
  
  type ExpandingChannelStructureInfo = ExpandingChannelStructureInfoEntry[]
  interface ExpandingChannelStructureInfoEntry {
    channel: Channel
    n: number
  }

  class ExpandingChannel {

    private channelName: string
    private parentChannel: Channel
    private minimumFree: number
    private regex: RegExp
    private deleteDelay: number
    private deleteTimeout: any
    private channelOpts: Omit<ChannelCreateParams, "name"|"parent"> = {}
    private deleteTimeoutActive: boolean = false
    private numeralMode: ExpandingChannelNumeral
    private permissions: PermissionConfig

    constructor(config: ExpandingChannelConfig) {
      this.channelName = config.name
      this.parentChannel = config.parent
      this.minimumFree = config.minimumFree
      this.regex = config.regex
      this.deleteDelay = config.deleteDelay
      this.channelOpts = config.channelOpts
      this.numeralMode = config.numeralMode
      this.permissions = config.permissions
      this.handleMoveEvent()
      setTimeout(() => this.checkFreeChannels(), 2 * 1000)
    }

    /** register events */
    private handleMoveEvent() {
      event.on("channelDelete", (channel, invoker) => {
        if (invoker && invoker.isSelf()) return
        const parent = channel.parent()
        if (!parent || !parent.equals(this.parentChannel)) return
        this.checkFreeChannels()
      })
      event.on("clientMove", ({ fromChannel, toChannel }) => {
        const toParent = toChannel && toChannel.parent()
        const fromParent = fromChannel && fromChannel.parent()
        if (toParent && toParent.equals(this.parentChannel)) {
          this.checkFreeChannels()
        } else if (fromParent && fromParent.equals(this.parentChannel)) {
          this.checkFreeChannels()
        }
      })
    }

    /** creates a new class from a configuration */
    static from(config: ChannelConfig) {
      if (!(/\%/).test(config.name))
        throw new Error(`Could not find channel identificator "%" in channel name "${config.name}"`)
      const parent = backend.getChannelByID(config.parent)
      if (!parent) throw new Error(`could not find parent channel id ${parent} on expanding channel with name "${config.name}"`)
      if (config.minfree < 1) throw new Error(`Minimum free Channels is smaller than 1! (${config.minfree})`)
      const channelOpts: Omit<ChannelCreateParams, "name"|"parent"> = {
        codec: config.codec === "0" ? 4 : 5,
        codecQuality: parseInt(config.quality, 10) + 1,
        maxClients: config.maxClients,
        description: config.description,
        topic: config.topic
      }
      if (config.talkpower > 0) channelOpts.neededTalkPower = config.talkpower
      return new ExpandingChannel({
        name: config.name,
        parent,
        minimumFree: config.minfree,
        deleteDelay: config.deleteDelay * 1000,
        channelOpts,
        permissions: config.permissions.filter(perm => perm.name !== "__INVALID__"),
        numeralMode: config.numerals === "0" ? ExpandingChannelNumeral.DECIMAL : ExpandingChannelNumeral.ROMAN,
        regex: new RegExp(`^${config.name
          .replace(/\(/g, "\\(").replace(/\)/g, "\\)")
          .replace(/\]/g, "\\]").replace(/\[/g, "\\[")
          .replace(/\^/g, "\\^").replace(/\./g, "\\.")
          .replace(/\*/g, "\\*").replace(/\+/g, "\\+")
          .replace(/\?/g, "\\?").replace(/\%/, "(.*)")}$`)
      })
    }

    /** retrieves a list of subchannels for the specified ExpandingChannel */
    private getSubChannels() {
      return backend.getChannels().filter(channel => {
        const parent = channel.parent()
        if (!parent) return false
        return !!parent.equals(this.parentChannel)
      })
    }

    private getEmptyChannels() {
      return this.getSubChannels().filter(c => c.getClientCount() === 0)
    }

    checkFreeChannels() {
      const channels = this.getSubChannels()
      this.updateChannels(channels)
      let freeChannels = this.getEmptyChannels().length
      if (freeChannels > this.minimumFree) {
        if (this.deleteDelay === 0) return this.deleteChannels(channels)
        this.deleteWithDelay()
      } else if (freeChannels < this.minimumFree) {
        clearTimeout(this.deleteTimeout)
        this.createChannels(channels, freeChannels)
      } else {
        clearTimeout(this.deleteTimeout)
      }
    }

    /** updates all channel names or deletes them if the name does not match */
    private updateChannels(channels: Channel[]) {
      channels.map(channel => {
        const num = this.getNumberFromName(channel.name())
        if (num === 0) channel.delete()
        const name = this.getChannelName(num)
        if (name === channel.name()) return
        channel.setName(name)
      })
    }

    /** starts a delay to delete channels */
    private deleteWithDelay() {
      if (this.deleteTimeoutActive) return
      this.deleteTimeoutActive = true
      this.deleteTimeout = setTimeout(() => {
        this.deleteTimeoutActive = false
        this.deleteChannels(this.getSubChannels())
      }, this.deleteDelay)
    }

    /** deletes some amount of channels */
    private deleteChannels(channels: Channel[]) {
      const structure = this.getChannelStructureInfo(channels)
        .filter(({ channel }) => channel.getClientCount() === 0)
      while (structure.length > this.minimumFree) {
        structure.pop()!.channel.delete()
      }
    }

    /** creates the required amount of channels */
    private createChannels(channels: Channel[], freeChannels: number) {
      while (freeChannels++ < this.minimumFree) {
        const structure = this.getChannelStructureInfo(channels)
        const num = this.getNextFreeNumber(structure)
        channels.push(this.createChannel(num, (num === 1 || structure.length === 0) ? "0" : structure[num-2].channel.id()))
      }
    }

    /** get a set of channels with its channel order number */
    getChannelStructureInfo(channels: Channel[]): ExpandingChannelStructureInfo {
      return channels
        .map(c => ({ channel: c, n: this.getNumberFromName(c.name())}))
        .sort((c1: any, c2: any) => c1.n - c2.n)    
    }

    /** creates a channel and sets all necessary parameters */
    private createChannel(num: number, position: string) {
      const channel = backend.createChannel({
        name: this.getChannelName(num),
        parent: this.parentChannel.id(),
        permanent: true,
        encrypted: true,
        position,
        ...this.channelOpts
      })
      if (!channel) throw new Error("error while trying to create a channel!")
      this.permissions.forEach(perm => {
        const permission = channel.addPermission(perm.name)
        permission.setValue(perm.value)
        if (perm.skip) permission.setSkip(true)
        if (perm.negate) permission.setNegated(true)
        const ok = permission.save()
        if (!ok) console.log(`there was a problem saving a permission!`, { perm })
      })
      return channel
    }

    /** gets the next free channel number in the structure */
    getNextFreeNumber(structure: ExpandingChannelStructureInfo) {
      const taken = structure.map(c => c.n)
      let i = 0
      while (taken.includes(++i)) {}
      return i
    }

    /**
     * retrieves the channels order number
     * @param name channel name to check
     */
    getNumberFromName(name: string) {
      const match = name.match(this.regex)
      if (!match) return 0
      const dec = parseInt(match[1], 10)
      if (!isNaN(dec)) {
        return dec
      } else if (Roman.isValid(match[1])) {
        return Roman.toArabic(match[1])
      } else {
        return 0
      }
    }

    /**
     * gets the actual name for this channel
     * @param num 
     */
    getChannelName(num: number) {
      const str = this.numeralMode === ExpandingChannelNumeral.DECIMAL ? String(num) : Roman.toRoman(num)
      return this.channelName.replace(/\%/, str)
    }
  }

  if (backend.isConnected()) {
    init()
  } else {
    event.on("connect", () => init())
  }

  function init() {
    channels.forEach(config => {
      ExpandingChannel.from(config)
    })
  }

}) 