///<reference path="../node_modules/sinusbot/typings/global.d.ts" />

import type { Client } from "sinusbot/typings/interfaces/Client"
import type { Command } from "sinusbot/typings/external/command"


interface Reward {
  amount: number
  group: number
  coins: number
}

registerPlugin<{
  key: string
  sid: string
  removeTime: number
  useMulticonomy: "0"|"1"
  rewards: Reward[]
}>({
  name: "Vote Reward",
  engine: ">= 1.0.0",
  version: "1.1.0",
  description: "Group Vote Rewards for TeamSpeakServers.org",
  author: "Multivitamin <david.kartnaller@gmail.com",
  requiredModules: ["http"],
  vars: [{
    type: "string" as const,
    name: "key",
    title: "TeamSpeak-Servers API Key",
    default: ""
  }, {
    type: "string" as const,
    name: "sid",
    title: "TeamSpeak-Servers Server ID",
    default: ""
  }, {
    type: "number" as const,
    name: "removeTime",
    title: "remove vote when older than x days (default: 30, -1 to disable removal)",
    default: 30
  }, {
    type: "select" as const,
    name: "useMulticonomy",
    title: "Use multiconomy features?",
    options: ["No", "Yes"],
    default: "0"
  }, {
    type: "array" as const,
    name: "rewards",
    title: "Group per vote",
    default: [],
    vars: [{
      type: "number" as const,
      name: "amount",
      title: "Amount of Votes in this month",
      default: 0
    }, {
      type: "number" as const,
      name: "group",
      title: "Group Reward",
      default: 0
    }, {
      type: "number" as const,
      name: "coins",
      title: "Coin Reward (only if multiconomy is enabled)",
      default: 0
    }]
  }]
}, (_, { key, sid, removeTime, rewards, ...config }) => {

  const multiconomy = config.useMulticonomy === "1"

  let initialized: boolean = false

  const rewardSorted = rewards.sort((g1, g2) => g1.amount - g2.amount).reverse()
  const availableGroups = rewards.map(g => g.group)

  const removeAfter = removeTime > 0 ? removeTime * 24 * 60 * 60 : -1

  const engine = require("engine")
  const event = require("event")
  const store = require("store")
  const http = require("http")
  const backend = require("backend")
  const helpers = require("helpers")
  const CHECK_INTERVAL = 60 * 1000

  /** item structure which will stored */
  interface VoteItem {
    identifier: string
    source: string
    timestamp: number
    hash: string
    added: number
    claimedBy: string|null
    claimedAt: number
  }

  type PartialVoteItem = Omit<Partial<VoteItem>, "timestmap"|"identifier"> & Pick<VoteItem, "timestamp"|"identifier"|"source">

  abstract class Vote {

    /** service name of the voting application */
    protected abstract service: string

    /** vote namespace name */
    protected abstract namespace: string

    /** executes the api call and requests via Vote#requestAdd to add the item to store */
    protected abstract check(): Promise<void>

    /** retrieves a client by its identifier */
    protected abstract getClientByIdentifier(identifier: string): Client|undefined

    /** retrieves the identifier for the client */
    protected abstract getIdentifierByClient(client: Client|string): string|undefined
  
    /** economy plugin */
    protected eco: any

    constructor({ eco }: { eco: any }) {
      this.eco = eco
    }

    /** initializes store */
    protected init() {
      if (!Array.isArray(this.getVotes())) this.setVotes([])
    }

    /** current store namespace */
    private ns(name: string) {
      return `${this.namespace}${name}`
    }
  
    /** retrieves the namespace for vote items */
    private get nsVotes() {
      return this.ns("votes")
    }

    /** retrieves all votes from store */
    private getVotes(): VoteItem[] {
      return store.getInstance(this.nsVotes)
    }

    /** saves all vote items back to store */
    private setVotes(items: VoteItem[]) {
      store.setInstance(this.nsVotes, items)
    }

    /** retrieves all votes */
    saveItem(item: VoteItem) {
      this.setVotes(this.getVotes().map(i => i.hash === item.hash ? item : i))
      return this
    }

    /** adds a vote item to the store */
    addItem(item: VoteItem) {
      this.setVotes([...this.getVotes(), item])
      return this
    }

    /** requests to add an item to the store */
    protected async requestAdd(item: PartialVoteItem) {
      const hash = this.getHash(item)
      if (this.findHash(hash)) return false
      if (this.isOld(item)) return false
      const newItem = this.createVoteItem(item)
      this.addItem(newItem)
      await this.tryMakeClaim(newItem)
      return true
    }

    /** checks if the item is too old to get added or still be hold in store */
    private isOld(item: PartialVoteItem) {
      if (removeAfter === -1) return false
      return item.timestamp < Math.floor(Date.now() / 1000) - removeAfter
    }
  
    /** retrieves the hash value of an item */
    private getHash(item: PartialVoteItem) {
      return helpers.MD5Sum(`${item.identifier}${item.timestamp}`)
    }

    /** finds an item with a specific hash */
    private findHash(hash: string) {
      return this.getVotes().find((item: VoteItem) => item.hash === hash)
    }

    /** handles a full client check */
    async checkClient(client: Client) {
      const id = this.getIdentifierByClient(client)
      if (!id) return
      const unclaimed = this.getUnclaimedByIdentifier(id)
      await Promise.all(unclaimed.map(item => this.tryMakeClaim(item, client)))
      this.checkGroups(client)
    }

    /** tries to claim a possible not claimed item */
    async tryMakeClaim(item: VoteItem, client?: Client) {
      if (!this.isUnclaimed(item)) return false
      client = client ? client : this.getClientByItem(item)
      if (!client) return false
      engine.log(`Client ${client.nick()} (${client.uid()}) claims a vote (${item.hash})`)
      this.flagItemClaimed(item, client.uid())
      this.saveItem(item)
      if (multiconomy) {
        const wallet: any = await this.eco.getWallet(client.uid())
        const reward = this.getRewardFromVoteCount(this.getVotesByClient(client).length)
        await wallet.addBalance(reward.coins, `Vote ${this.service}`)
        client.chat(`You have been rewarded ${reward.coins}${this.eco.getCurrencySign()} for your vote!`)
      }
      this.checkGroups(client)
      return true
    }

    /** checks wether an item is unclaimed or not */
    private isUnclaimed(item: VoteItem) {
      return item.claimedBy === null
    }

    /** tries to retrieve the client for which the vote is for */
    private getClientByItem(item: VoteItem) {
      return this.getClientByIdentifier(item.identifier)
    }

    /** validates the groups a client has */
    protected checkGroups(client: Client) {
      const { group } = this.getRewardFromVoteCount(this.getVotesByClient(client).length)
      if (group === -1) return
      return this.whiteListGroup(
        client,
        [group],
        availableGroups
      )
    }

    /**
     * adds a set of groups to a client and removes groups he should not be in
     * @param client the client to add/remove groups from
     * @param group the groups a client can have
     * @param whitelisted whitelisted groups
     */
    private whiteListGroup(client: Client, groups: (number|string)[], whitelisted: (number|string)[]) {
      const assign = groups.map(g => String(g))
      const remove = whitelisted.map(w => String(w)).filter(w => !assign.includes(w))
      client.getServerGroups().forEach(group => {
        if (remove.includes(group.id())) {
          client.removeFromServerGroup(group.id())
        } else if (assign.includes(group.id())) {
          assign.splice(assign.indexOf(group.id()), 1)
        }
      })
      assign.forEach(g => client.addToServerGroup(g))
    }


    /**
     * retrieves the servergroup the amount of counts should get
     * @param votes the amount of votes to retrieve the group
     */
    getRewardFromVoteCount(votes: number): Reward {
      const reward = rewardSorted.find(g => g.amount <= votes)
      if (reward) return reward
      if (rewardSorted.length === 0 || rewardSorted[0].amount > votes) {
        return { group: -1, amount: -1, coins: 0 }
      } else {
        return rewardSorted[rewardSorted.length - 1]
      }
    }

    /**
     * retrieves the vote items a client has been assigned
     * @param client the client to retrieve
     */
    protected getVotesByClient(client: Client) {
      return this.getVotes().filter(item => item.claimedBy === client.uid())
    }

    /**
     * gets all unclaimed votes a client nickname can be assigned to
     * @param nick the nickname to check
     */
    protected getUnclaimedByIdentifier(identifier: string) {
      return this.getVotes()
        .filter(item => this.isUnclaimed(item))
        .filter(item => item.identifier === identifier)
    }

    /**
     * removes all items which are older than the days given in config
     */
    private cleanOldItems() {
      const votes = this.getVotes()
      const cleaned = votes.filter(item => !this.isOld(item))
      if (votes.length === cleaned.length) return
      this.setVotes(cleaned)
    }

    /**
     * interval checks
     * removes old items from the store
     */
    cron() {
      this.cleanOldItems()
      this.check()
    }

    /**
     * sets an items status to claimed
     * @param item the item which should get claimed
     * @param uid the uid which claimed the item
     */
    private flagItemClaimed(item: VoteItem, uid: string) {
      item.claimedBy = uid
      item.claimedAt = Date.now()
      return this
    }

    /**
     * creates a fully valid VoteItem
     * @param item the item which should be upgraded
     */
    private createVoteItem(item: PartialVoteItem): VoteItem {
      return {
        ...item,
        added: Date.now(),
        hash: this.getHash(item),
        claimedBy: null,
        claimedAt: 0
      }
    }

  }
  
  type TeamSpeakServersVoteResponse = TeamSpeakServersVoteResponseItem[]
  interface TeamSpeakServersVoteResponseItem {
    date: string
    timestamp: number
    identifier: string
    steamid: string
    claimed: string
  }

  class TeamSpeakServers extends Vote {

    protected namespace = "teamspeakServersDotOrg_"
    protected service = "TeamSpeak-Servers.org"
    private apikey: string
    private sid: string
    private steam: any

    constructor({ key, sid, createCommand, eco, steam }: { key: string, sid: string, createCommand: (cmd: string) => Command.Command, eco: any, steam: any}) {
      super({ eco })
      this.steam = steam
      this.apikey = key
      this.sid = sid
      this.registerCommand(createCommand)
      this.init()
    }

    protected getClientByIdentifier(identifier: string) {
      const uid = this.steam.getUidFromSteamId(identifier)
      if (!uid) return
      return backend.getClientByUID(uid)
    }

    protected getIdentifierByClient(client: Client|string): string|undefined {
      return this.steam.getSteamId(client)
    }

    /**
     * registers the voting command
     */
    private registerCommand(createCommand: (cmd: string) => Command.Command) {
      createCommand("vote")
        .help("retrieves the vote link from teamspeak-servers.org")
        .manual("retrieves the vote link for teamspeak-servers.org")
        .manual(`vote daily to get rewarded with servergroups!`)
        .exec((client, _, reply) => {
          if (!this.steam.getSteamId(client)) return reply(`No SteamID has been connected to your teamspeak client use "${this.steam.getCommandName()}" for more informations!`)
          reply(`[b][url=https://teamspeak-servers.org/server/${this.sid}/vote/?username=${encodeURI(client.nick())}]VOTE HERE[/url]`)
          reply(`It can take a few minutes until your vote gets counted!`)
          if (removeAfter === -1) {
            reply(`You have voted ${this.getVotesByClient(client).length} times!`)
          } else {
            reply(`You have voted ${this.getVotesByClient(client).length} times in the last ${removeTime} days!`)
          }
          if (multiconomy) {
            const votes = this.getVotesByClient(client).length + 1
            reply(`You get rewarded ${this.getRewardFromVoteCount(votes).coins}${this.eco.getCurrencySign()} for your next vote!`)
          }
        })
    }
  
  
    protected async check() {
      const votes = await this.fetchVotes()
      votes.forEach(vote => this.requestAdd({
        identifier: vote.steamid,
        timestamp: vote.timestamp * 1000,
        source: this.namespace
      }))
    }


    /** retrieves the votes from the api */
    private fetchVotes(): Promise<TeamSpeakServersVoteResponse> {
      return new Promise((fulfill, reject) => {
        http.simpleRequest({
          method: "GET",
          url: `https://teamspeak-servers.org/api/?object=servers&element=votes&key=${this.apikey}&format=json`
        }, (err, res) => {
          if (err) return reject(new Error(`Failed to retrieve data from teamspeak-servers.org api! (Error ${err})`))
          if (res.statusCode !== 200) return reject(new Error(`Failed to retrieve data from teamspeak-servers.org api! (Code ${res.statusCode})`))
          try {
            fulfill(JSON.parse(res.data.toString()).votes)
          } catch (e) {
            engine.log(`got response from teamspeak-servers.org: ${res.data.toString()}`)
            return reject(e)
          }
        })
      })
    }
  }

  const votings: Vote[] = []

  function doGlobalCheck() {
    votings.forEach(vote => vote.cron())
    backend.getClients()
      .filter(c => !c.isSelf())
      .forEach(c => votings.forEach(v => v.checkClient(c)))
  }
  
  event.on("connect", () => {
    if (initialized) return
    initialized = true
    doGlobalCheck()
  })

  event.on("disconnect", () => {
    initialized = false
  })  

  //action for when a client connects
  event.on("clientMove", ({fromChannel, client}) => {
    if (fromChannel || client.isSelf()) return
    votings.forEach(v => v.checkClient(client))
  })
  
  //action for when a client changes its nickname
  event.on("clientNick", client => votings.forEach(v => v.checkClient(client)))

  //action for when a client gets removed from a servergroup
  event.on("serverGroupAdded", ev => {
    if (ev.invoker.isSelf()) return
    votings.forEach(v => v.checkClient(ev.client))
  })
  
  //action for when a client gets added to a servergroup
  event.on("serverGroupRemoved", ev => {
    if (ev.invoker.isSelf()) return
    votings.forEach(v => v.checkClient(ev.client))
  })

  setInterval(() => {
    if (!backend.isConnected()) return
    votings.forEach(vote => vote.cron())
  }, CHECK_INTERVAL)

  event.on("load", () => {

    let eco: any = null

    if (multiconomy) {
      eco = require("MultiConomy")
      if (!eco) throw new Error("MultiConomy.js not found! Please be sure to install and enable MultiConomy.js")
    }

    const steam = require("steam")
    if (!steam) throw new Error("This plugin requires steam.js! (Is it disabled or missing?) Please download this plugin from the resource section and enable it!")

    const command = require("command")
    const { createCommand } = command

    votings.push(new TeamSpeakServers({ key, sid, createCommand, eco, steam }))

    if (backend.isConnected()) {
      initialized = true
      doGlobalCheck()
    }
  })
})