///<reference path="../node_modules/sinusbot/typings/global.d.ts" />

import type { Channel } from "sinusbot/typings/interfaces/Channel"

interface ExpandingChannelConf {
  parent: string
  name: string
  minfree: number
  deleteDelay: number
}
type ExpandingChannelStructureInfo = ExpandingChannelStructureInfoEntry[]
interface ExpandingChannelStructureInfoEntry {
  channel: Channel
  n: number
}

registerPlugin<{
  channels: ExpandingChannelConf[]
}>({
  name: "Expanding Channels",
  engine: ">= 1.0.0",
  version: "0.1.0",
  description: "automatic channel creation tool based on use",
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
    }]
  }]
}, (_, { channels }) => {

  const event = require("event")
  const backend = require("backend")

  class ExpandingChannel {

    private channelName: string
    private parentChannel: Channel
    private minimumFree: number
    private regex: RegExp
    private deleteDelay: number
    private deleteTimeout: any
    private deleteTimeoutActive: boolean = false

    constructor(config: { name: string, parent: Channel, minimumFree: number, regex: RegExp, deleteDelay: number }) {
      this.channelName = config.name
      this.parentChannel = config.parent
      this.minimumFree = config.minimumFree
      this.regex = config.regex
      this.deleteDelay = config.deleteDelay
      this.handleMoveEvent()
      setTimeout(() => this.checkFreeChannels(), 2 * 1000)
    }

    private handleMoveEvent() {
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

    static from(config: ExpandingChannelConf) {
      if (!(/\%/).test(config.name))
        throw new Error(`Could not find channel identificator '%' in channel name '${config.name}'`)
      const parent = backend.getChannelByID(config.parent)
      if (!parent) throw new Error(`could not find parent channel id ${parent} on expanding channel with name '${config.name}'`)
      if (config.minfree < 1) throw new Error(`Minimum free Channels is smaller than 1! (${config.minfree})`)
      return new ExpandingChannel({
        name: config.name,
        parent,
        minimumFree: config.minfree,
        deleteDelay: config.deleteDelay * 1000,
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
    private deleteWithDelay() {
      if (this.deleteTimeoutActive) return
      this.deleteTimeoutActive = true
      this.deleteTimeout = setTimeout(() => {
        this.deleteTimeoutActive = false
        this.deleteChannels(this.getSubChannels())
      }, this.deleteDelay)
    }

    private deleteChannels(channels: Channel[]) {
      const structure = this.getChannelStructureInfo(channels)
        .filter(({ channel }) => channel.getClientCount() === 0)
      while (structure.length > this.minimumFree) {
        structure.pop()!.channel.delete()
      }
    }

    private createChannels(channels: Channel[], freeChannels: number) {
      while (freeChannels++ < this.minimumFree) {
        const structure = this.getChannelStructureInfo(channels)
        const num = this.getNextFreeNumber(structure)
        channels.push(this.createChannel(num, structure.length > 0 ? structure[num-2].channel.id() : "0"))
      }
    }

    getChannelStructureInfo(channels: Channel[]): ExpandingChannelStructureInfo {
      return channels
        .map(c => ({ channel: c, n: this.getNumberFromName(c.name())}))
        .sort((c1: any, c2: any) => c1.n - c2.n)    
    }

    private createChannel(num: number, position: string) {
      return backend.createChannel({
        name: this.getChannelName(num),
        parent: this.parentChannel.id(),
        permanent: true,
        encrypted: true,
        position
      })
    }

    getNextFreeNumber(structure: ExpandingChannelStructureInfo) {
      const taken = structure.map(c => c.n)
      let i = 0
      while (taken.includes(++i)) {}
      return i
    }

    getNumberFromName(name: string) {
      const match = name.match(this.regex)
      if (!match) return 0
      return parseInt(match[1])
    }

    getChannelName(num: number) {
      return this.channelName.replace(/\%/, String(num))
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