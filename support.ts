///<reference path="node_modules/sinusbot/typings/global.d.ts" />

import type { Client } from "sinusbot/typings/interfaces/Client"
import type { Command } from "sinusbot/typings/external/command"


type SupportRoles = SupportRole[]
interface SupportRole {
  cid: string
  sgid: string[]
  permBlacklist: boolean
  department: string
  description: string
}


interface StorageProviderBlackListEntry {
  uid: string
  until: number
  reason: string
  invoker: string
}


interface StorageProvider {

  /**
   * gets called when the store gets setup
   * here you can create database creation logic or similar
   * @param namespace namespace to load
   */
  setup(namespace: string): Promise<void>

  /**
   * checks wether a client is blacklisted
   * @param uid the client uid to check
   */
  isBlacklisted(uid: string): Promise<boolean>

  /**
   * retrieves the blacklist entry for the given uid
   * @param uid the client uid to retrieve
   */
  getBlacklistEntry(uid: string): Promise<StorageProviderBlackListEntry>

  /**
   * adds a new client to the blacklist
   * @param uid the clients uid to blacklist
   */
  addBlacklist(entry: StorageProviderBlackListEntry): Promise<void>

  /**
   * removes a client from the blacklist
   * @param uid the uid to remove
   */
  removeBlacklist(uid: string): Promise<void>
}

interface Configuration {
  supportChannel: string
  command: string
  useDynamicChannelName: string
  channelNameOnline: string
  channelNameOffline: string
  roles: SupportRoles
  DEBUGLEVEL: number
}

registerPlugin<Configuration>({
  name: "Support",
  engine: ">= 1.0.0",
  version: "1.0.0",
  description: "Script for Support Requests on TeamSpeak Servers",
  author: "Multivitamin <david.kartnaller@gmail.com",
  vars: [{
    type: "channel" as const,
    name: "supportChannel",
    title: "Support Channel",
    default: "-1"
  }, {
    type: "string" as const,
    name: "command",
    title: "chat command name (default: support)",
    default: "support"
  }, {
    type: "select" as const,
    name: "useDynamicChannelName",
    title: "use dynamic support channel name?",
    options: ["No", "Yes"],
    default: "0"
  }, {
    type: "string" as const,
    name: "channelNameOnline",
    title: "channel name when minimum 1 supporter is online (placeholders: %count% - amount of supporters online)",
    default: "Support %count% online",
    conditions: [{
      field: "useDynamicChannelName",
      value: "1"
    }]
  }, {
    type: "string" as const,
    name: "channelNameOffline",
    title: "channel name when no supporter is online",
    default: "Support offline",
    conditions: [{
      field: "useDynamicChannelName",
      value: "1"
    }]
  }, {
    type: "array" as const,
    name: "roles",
    title: "Support Roles",
    vars: [{
      type: "strings" as const,
      title: "Servergroups",
      name: "sgid",
      default: []
    }, {
      type: "channel" as const,
      title: "Support Channel for this group",
      name: "cid",
      default: "-1"
    }, {
      type: "checkbox" as const,
      title: "allow support blacklist?",
      name: "permBlacklist",
      default: false
    }, {
      type: "string" as const,
      title: "department of this role",
      name: "department",
      default: "NO_department_GIVEN"
    }, {
      type: "string" as const,
      title: "description of this role",
      name: "description",
      default: "NO_DESCRIPTION_GIVEN"
    }],
    default: []
  }, {
    name: "DEBUGLEVEL",
    title: "Debug Messages (default is INFO)",
    type: "select",
    options: ["ERROR", "WARNING", "INFO", "VERBOSE"],
    default: "2"
  }]
}, (_, config) => {

  enum LOGLEVEL {
    ERROR = "ERROR",
    WARNING = "WARNING",
    INFO = "INFO",
    VERBOSE = "VERBOSE"
  }

  enum SupportRequestResponse {
    OK,
    BLACKLISTED
  }

  const MAX_CHANNEL_NAME_LENGTH = 40

  /** @param level current debug level */
  function DEBUG(level: LOGLEVEL) {
    /**
     * @param mode the loglevel the message should be logged with
     * @param args data to log
     */
    const logger = (mode: LOGLEVEL, ...args: any[]) => {
      if (mode > level) return
      console.log(`[${mode}]`, ...args)
    }
    return (mode: LOGLEVEL) => logger.bind(null, mode)
  }

  const debug = DEBUG([LOGLEVEL.ERROR, LOGLEVEL.WARNING, LOGLEVEL.INFO, LOGLEVEL.VERBOSE][config.DEBUGLEVEL])



  class Role {

    private cid: string
    private sgid: string[]
    private perms: Record<string, boolean> = {}
    private backend = require("backend")
    readonly department: string
    readonly description: string

    constructor(role: SupportRole) {
      this.cid = role.cid
      this.sgid = role.sgid
      this.department = role.department
      this.description = role.description
      this.setPerm("blacklist", role.permBlacklist)
    }

    /**
     * retrieves the channel
     */
    getChannel() {
      const channel = this.backend.getChannelByID(this.cid)
      if (!channel) throw new Error(`could not get channel with id '${this.cid}' for role '${this.department}'`)
      return channel
    }

    /**
     * checks if the client is in this role
     * @param client client to check
     */
    hasRole(client: Client) {
      return client.getServerGroups().map(g => g.id()).some(sgid => this.sgid.includes(sgid))
    }

    /**
     * sets a permission
     * @param name the permission name to set
     * @param value the value to set
     */
    private setPerm(name: string, value: boolean = false) {
      this.perms[name] = value
      return this
    }

    /**
     * gets a specific permission
     * @param name the permission name to retrieve
     */
    getPerm(name: string) {
      return Boolean(this.perms[name])
    }
  }



  class BaseStore implements StorageProvider {

    private namespace: string = ""
    readonly store = require("store")

    private get(name: "blacklist"): StorageProviderBlackListEntry[]
    private get(name: string) {
      return this.store.getInstance(`${this.namespace}${name}`)
    }

    private set(name: "blacklist", value: StorageProviderBlackListEntry[]): void
    private set(name: string, value: any): void {
      this.store.setInstance(`${this.namespace}${name}`, value)
    }

    get storeBlacklist() {
      return `${this.namespace}blacklist`
    }

    setup(namespace: string) {
      this.namespace = namespace
      if (!Array.isArray(this.get("blacklist"))) this.set("blacklist", [])
      return Promise.resolve()
    }

    isBlacklisted(uid: string) {
      return Promise.resolve(
        this.get("blacklist").some(entry => entry.uid === uid)
      )
    }

    addBlacklist(entry: StorageProviderBlackListEntry) {
      if (this.isBlacklisted(entry.uid))
        return Promise.reject(new Error(`the uid '${entry.uid}' is already blacklisted`))
      this.set("blacklist", [...this.get("blacklist"), entry])
      return Promise.resolve()
    }

    removeBlacklist(uid: string) {
      this.set("blacklist", this.get("blacklist").filter(entry => entry.uid !== uid))
      return Promise.resolve()
    }

    getBlacklistEntry(uid: string) {
      const entry = this.get("blacklist").find(entry => entry.uid === uid)
      if (entry) {
        return Promise.resolve(entry)
      } else {
        return Promise.reject(new Error(`could not find blacklist entry '${uid}'`))
      }
    }


  }



  interface SupportConfig {
    storage: StorageProvider
    supportChannel: string
    command: string
    useDynamicChannelName: string
    channelNameOnline: string
    channelNameOffline: string
    roles: Role[]
  }

  type SupportQueue = Queue[]

  class Support {

    readonly config: SupportConfig
    readonly backend = require("backend")
    readonly format = require("format")
    readonly cmd: Command.CommandGroup
    private readonly queue: SupportQueue = []
    private readonly pendingRequest: RequestChallenge[] = []
    private readonly challengeQueue: { [uid: string]: ChallengeQueue<SupportResponseChallenge> } = {}

    constructor(config: SupportConfig) {
      this.config = config
      let cmd = config.command
      if (typeof cmd !== "string" || cmd.length < 1 || (/\s/).test(cmd)) {
        engine.log(`Invalid command name provided '${cmd}' using fallback name "sup"`)
        cmd = "support"
      }
      this.cmd = require("command").createCommandGroup(cmd)
    }

    get roles() {
      return this.config.roles
    }

    get store() {
      return this.config.storage
    }

    /**
     * retrieves the client by its id, otherwise throws an error
     * @param uid the uid of the client to retrieve
     */
    getClient(uid: string) {
      const client = this.backend.getClients().find(c => c.uid() === uid)
      if (!client) throw new Error(`Client with uid ${uid} not found!`)
      return client
    }

    /**
     * checks wether a client is blacklisted or not
     * @param client client object or uid
     */
    isBlacklisted(client: Client|string) {
      return this.store.isBlacklisted(typeof client === "string" ? client : client.uid())
    }

    /**
     * gets the reason of the blacklist
     * @param client client object or uid
     */
    getBlacklistEntry(client: Client|string) {
      return this.store.getBlacklistEntry(typeof client === "string" ? client : client.uid())
    }

    /**
     * setup functions
     */
    async setup(namespace: string) {
      await this.store.setup(namespace)
      this.cmd.help("manage support requests")
      this.cmd
        .addCommand("request")
        .help("requests a supporter")
        .checkPermission(client => this.clientInRequestChallengeState(client, RequestChallengeState.ASK_INQUIRY))
        .addArgument(args => args.number.setName("inquiry").integer().max(this.config.roles.length - 1).min(0))
        .exec((client, args) => {
          const challenge = this.clientGetChallenge(client)
          if (!challenge) return client.chat("Whooops something went wrong! (Challenge not found)")
          challenge.setInquiry(args.inquiry)
        })
      this.cmd
        .addCommand("describe")
        .help("describes your support issue")
        .checkPermission(client => this.clientInRequestChallengeState(client, RequestChallengeState.DESCRIBE_ISSUE))
        .addArgument(args => args.rest.setName("issue"))
        .exec((client, args) => {
          const challenge = this.clientGetChallenge(client)
          if (!challenge) return client.chat("Whooops something went wrong! (Challenge not found)")
          challenge.setIssue(args.issue)
        })
      this.cmd
        .addCommand("accept")
        .help("accepts a request")
        .checkPermission(client => this.clientInChallengeQueueState(client, SupportResponseChallengeState.REQUEST))
        .exec(client => {
          const queue = this.clientGetChallengeQueue(client)
          if (!queue || !queue.active) return client.chat("Whooops something went wrong! (Queue not found or not active)")
          queue.active.accept()
        })
      this.cmd
        .addCommand("decline")
        .help("declines a request")
        .checkPermission(client => this.clientInChallengeQueueState(client, SupportResponseChallengeState.REQUEST))
        .exec(client => {
          const queue = this.clientGetChallengeQueue(client)
          if (!queue || !queue.active) return client.chat("Whooops something went wrong! (Queue not found or not active)")
          queue.active.decline()
        })
    }

    /**
     * adds a new item to the challenge queu
     * @param uid client uid
     * @param item item to add
     */
    addChallengeQueue(uid: string, item: SupportResponseChallenge) {
      if (!(this.challengeQueue[uid] instanceof ChallengeQueue))
        this.challengeQueue[uid] = new ChallengeQueue()
      this.challengeQueue[uid].add(item)
      item.challengeQueue = this.challengeQueue[uid]
      return this
    }

    /**
     * retrieves the challenge of the given client
     * @param client the client to retrieve the state for
     */
    clientGetChallenge(client: Client) {
      return this.pendingRequest.find(req => client.uid() === req.client.uid())
    }

    /**
     * checks wether a client is in a challenge state
     * @param client the client to check
     * @param state the state to check if he is in
     */
    clientInRequestChallengeState(client: Client, state: RequestChallengeState) {
      const challenge = this.clientGetChallenge(client)
      if (!challenge) return false
      return challenge.state === state
    }

    /**
     * retrieves a queue class for the client or undefined if none active
     * @param client client to request the queue from
     */
    clientGetChallengeQueue(client: Client) {
      return this.challengeQueue[client.uid()]
    }

    /**
     * checks if a client is in a specific challenge state
     * @param client client to check the challenge state
     * @param state checks if the client is in this state
     */
    clientInChallengeQueueState(client: Client, state: SupportResponseChallengeState) {
      const queue = this.clientGetChallengeQueue(client)
      if (!queue || !queue.active) return false
      return queue.active.state === state
    }

    /**
     * retrieves a list of clients which are supporters and online
     * @param department requested department
     */
    getOnlineSupporters(department?: string) {
      return this.backend.getClients()
        .filter(client => this.isSupporter(client, department))
        .map(client => ({
          client,
          roles: this.getClientSupportRoles(client)
        }))
    }

    /**
     * retrieves support roles of a specific Client
     * @param client the client to check
     * @param department the department to get
     */
    getClientSupportRoles(client: Client, department?: string): Role[] {
      const roles = this.roles.filter(role => role.hasRole(client))
      if (!department) return roles
      return roles.filter(role => role.department === department)
    }

    /**
     * checks wether a client is in a support group
     * of the requested department
     * @param client the client which should be checked
     * @param department the department he should be in
     */
    isSupporter(client: Client, department?: string) {
      return this.getClientSupportRoles(client, department).length > 0
    }

    /**
     * completes the request challenge and returns the result
     * @param challenge 
     */
    private getChallengeComplete(challenge: RequestChallenge) {
      const queue = new Queue({
        uid: challenge.client.uid(),
        nick: challenge.client.nick(),
        issue: challenge.result.issue!,
        role: challenge.result.role!,
        support: this
      })
      this.queue.push(queue)
      this.getOnlineSupporters(challenge.result.role!.department)
        .forEach(({ client }) => {
          const challenge = new SupportResponseChallenge({
            support: this, queue, uid: client.uid()
          })
          this.addChallengeQueue(client.uid(), challenge)
        })
    }

    /**
     * creates a new support inquiry
     * @param client 
     */
    async requestSupport(client: Client): Promise<SupportRequestResponse> {
      if (await this.isBlacklisted(client)) return SupportRequestResponse.BLACKLISTED
      const challenge = new RequestChallenge({
        client,
        support: this,
        done: this.getChallengeComplete.bind(this)
      })
      this.pendingRequest.push(challenge)
      challenge.challenge()
      return SupportRequestResponse.OK
    }

    /**
     * retrieves the sinusbot support channel object
     */
    private getSupportChannel() {
      const channel = this.backend.getChannelByID(this.config.supportChannel)
      if (!channel) throw new Error(`Could not find the support channel with id ${this.config.supportChannel}`)
      return channel
    }

    /**
     * gets called when sinusbot connects to a server
     */
    onConnect() {
      this.supportCountChange()
    }

    /**
     * handles support count change
     */
    supportCountChange() {
      if (this.config.useDynamicChannelName === "0") return
      const count = this.getOnlineSupporters().length
      debug(LOGLEVEL.VERBOSE)(`Support count changed! (${count})`)
      const name = count === 0 ? this.config.channelNameOffline : this.config.channelNameOnline.replace("%count%", String(count))
      if (name.length > MAX_CHANNEL_NAME_LENGTH) throw new Error(`Support Channel name length exceeds limit of ${MAX_CHANNEL_NAME_LENGTH} characters! (${name})`)
      const channel = this.getSupportChannel()
      if (channel.name() !== name) channel.setName(name)
    }
  }



  interface QueueConfig {
    uid: string
    nick: string
    role: Role
    issue: string
    support: Support
  }


  class Queue {

    private uid: string
    private nick: string
    readonly role: Role
    readonly issue: string
    private parent: Support

    constructor(config: QueueConfig) {
      this.uid = config.uid
      this.nick = config.nick
      this.role = config.role
      this.issue = config.issue
      this.parent = config.support
    }

    /** serializes data to be able to save it */
    serialize() {
      return JSON.stringify({
        uid: this.uid,
        nick: this.nick,
        issue: this.issue,
        role: this.role
      })
    }

    /** deserializes data from a string */
    static deserialize(serialized: string) {
      const data = JSON.parse(serialized)
      if (
        typeof data !== "object" &&
        typeof data.uid !== "string" &&
        typeof data.nick !== "string" &&
        typeof data.issue !== "string" &&
        typeof data.role !== "object"
      ) {
        throw new Error(`unable to deserialize data '${serialized}'`)
      }
      return new Queue(data)
    }

    /**
     * checks if the client is online
     */
    isOnline() {
      try {
        return Boolean(this.getClient())
      } catch (e) {
        return false
      }
    }

    getClient() {
      return this.parent.getClient(this.uid)
    }

    /**
     * gets a list of available supporters for this case
     */
    supporters() {
      return this.parent.getOnlineSupporters(this.role.department)
    }
  }




  abstract class Challenge<T extends number> {

    private stateObservers: ((event: {from: T, to: T }) => void)[] = []
    private cbs: Record<number, () => void> = []
    private challengeState: T

    /**
     * @param initState the initial state
     */
    constructor(initState: T) {
      this.challengeState = initState
    }

    /** gets the current state of the challenge */
    get state() {
      return this.challengeState
    }

    /**
     * observes state changes and emits events
     * @param cb callback which gets executed when the state changes
     */
    onStateChange(cb: (event: {from: T, to: T }) => void) {
      this.stateObservers.push(cb)
      return this
    }

    /**
     * changes the state and emits to observers
     * @param to the new state
     */
    private setState(to: T) {
      const from = this.challengeState
      this.challengeState = to
      this.stateObservers.forEach(cb => cb({ from, to }))
    }

    /**
     * sets the callbacks which are being executed in order
     * @param cbs 
     */
    protected setCallback(index: T, cb: () => void) {
      this.cbs[index] = cb
      return this
    }

    /**
     * retrieves a callback by its index
     * @param index the index to get
     */
    private getCallback(index: T): () => void {
      if (typeof this.cbs[index] === "function") return this.cbs[index]
      return () => null
    }

    /**
     * runs the next available challenge
     * @param state the state to run
     */
    protected nextState(state: T) {
      this.setState(state)
      this.challenge()
    }

    /* starts the current challenge */
    challenge() {
      if (typeof this.cbs[this.challengeState] !== "function")
        throw new Error(`No function available to execute next`)
      this.getCallback(this.challengeState)()
    }

  }

  interface RequestChallengeConfig {
    client: Client,
    support: Support
    done: (challenge: RequestChallenge) => void
  }

  interface RequestChallengeResult {
    role: Role
    issue: string
  }

  enum RequestChallengeState {
    ASK_INQUIRY,
    DESCRIBE_ISSUE,
    DONE
  }


  class RequestChallenge extends Challenge<RequestChallengeState> {
    readonly client: Client
    private readonly parent: Support
    result: Partial<RequestChallengeResult> = {}
    private readonly done: (challenge: RequestChallenge) => void

    constructor(config: RequestChallengeConfig) {
      super(RequestChallengeState.ASK_INQUIRY)
      this.setCallback(RequestChallengeState.ASK_INQUIRY, this.checkInquiry.bind(this))
      this.setCallback(RequestChallengeState.DESCRIBE_ISSUE, this.describeIssue.bind(this))
      this.setCallback(RequestChallengeState.DONE, this.complete.bind(this))
      this.client = config.client
      this.parent = config.support
      this.done = config.done
    }

    private checkInquiry() {
      this.client.chat(`What inquiry do you have?`)
      let res = ""
      this.parent.roles.forEach((role, index) => {
        const cmd = this.parent.format.bold(`${this.parent.cmd.getFullCommandName()} request ${index}`)
        res += `\n${cmd}\n${role.department} - ${role.description}`
        res += `\n${this.parent.getOnlineSupporters(role.department).length} online\n`
      })
      this.client.chat(res)
    }

    private describeIssue() {
      const describe = this.parent.format.bold(`${this.parent.cmd.getFullCommandName()} describe YOUR_DESCRIPTION_HERE`)
      this.client.chat(`\nPlease describe your issue, use the following command:\n${describe}`)
    }

    private complete() {
      this.client.chat("Your issue has been forwarded to an available Supporter!")
      this.done(this)
    }

    setInquiry(index: number) {
      const role = this.parent.roles[index]
      if (!role) return this.nextState(RequestChallengeState.ASK_INQUIRY)
      this.result.role = role
      return this.nextState(RequestChallengeState.DESCRIBE_ISSUE)
    }

    setIssue(issue: string) {
      if (issue.length < 10) {
        this.client.chat("Your issue description seems kinda short! Please try again!")
        return this.nextState(RequestChallengeState.DESCRIBE_ISSUE)
      }
      this.result.issue = issue
      return this.nextState(RequestChallengeState.DONE)
    }
  
  }


  interface SupportResponseChallengeConfig {
    support: Support
    queue: Queue
    uid: string
  }

  enum SupportResponseChallengeState {
    WAITING,
    REQUEST,
    ACCEPT,
    DECLINE,
    TIMEOUT,
    COMPLETE,
    UNRESOLVED
  }

  class SupportResponseChallenge extends Challenge<SupportResponseChallengeState> implements IChallengeQueue {

    private parent: Support
    private queue: Queue
    challengeQueue?: ChallengeQueue<any>
    private uid: string

    constructor(config: SupportResponseChallengeConfig) {
      super(SupportResponseChallengeState.WAITING)
      this.parent = config.support
      this.queue = config.queue
      this.uid = config.uid
      this.setCallback(SupportResponseChallengeState.REQUEST, this.request.bind(this))
      this.setCallback(SupportResponseChallengeState.ACCEPT, this.accepted.bind(this))
    }

    start() {
      return this.nextState(SupportResponseChallengeState.REQUEST)
    }

    private request() {
      const client = this.queue.getClient()
      let request = `\nNew support request from [URL=${client.getURL()}]${client.name()}[/URL] with issue:\n${this.parent.format.italic(this.queue.issue)}\n`
      const accept = this.parent.format.bold(`${this.parent.cmd.getFullCommandName()} accept`)
      const decline = this.parent.format.bold(`${this.parent.cmd.getFullCommandName()} decline`)
      request += `\nUse ${accept} to accept the support request`
      request += `\nUse ${decline} to decline the support request`
      this.getSupporterClient().chat(request)
    }

    private getSupporterClient() {
      return this.parent.getClient(this.uid)
    }

    private accepted() {
      const supporter = this.getSupporterClient()
      const client = this.queue.getClient()
      const channel = this.queue.role.getChannel()
      supporter.moveTo(channel)
      client.moveTo(channel)
    }

    accept() {
      this.nextState(SupportResponseChallengeState.ACCEPT)
    }

    decline() {
      this.nextState(SupportResponseChallengeState.DECLINE)
      if (this.challengeQueue) this.challengeQueue.stopActive()
    }
  }


  interface IChallengeQueue {
    start(): void
  }
  type ChallengeQueueItem<T extends Challenge<any>> = IChallengeQueue & T

  class ChallengeQueue<T extends Challenge<any>> {

    active?: ChallengeQueueItem<T>
    readonly challenges: ChallengeQueueItem<T>[] = []

    /**
     * adds an item to the challenge Queue
     * @param item item to add
     */
    add(item: ChallengeQueueItem<T>) {
      this.challenges.push(item)
      if (!this.active) this.next()
    }

    /**
     * stops the currently active element
     * and starts the next in queue
     */
    stopActive() {
      this.active = undefined
      this.next()
    }

    /**
     * starts the next item in queue
     */
    next() {
      const item = this.challenges.shift()
      if (!item) return
      this.active = item
      item.start()
    }

  }



  const event = require("event")
  const engine = require("engine")

  if (config.roles.length === 0) {
    debug(LOGLEVEL.ERROR)("No supporter roles in your config defined!")
    debug(LOGLEVEL.ERROR)("Please setup your script first!")
    return
  }


  event.on("load", async () => {
    debug(LOGLEVEL.VERBOSE)("support script initializing...")
  
    const support = new Support({
      storage: new BaseStore(),
      useDynamicChannelName: config.useDynamicChannelName,
      channelNameOffline: config.channelNameOffline,
      channelNameOnline: config.channelNameOnline,
      supportChannel: config.supportChannel,
      roles: config.roles.map(role => new Role(role)),
      command: config.command
    })   
    await support.setup("")
  
    if (support.backend.isConnected()) support.onConnect()
    event.on("connect", () => setTimeout(() => support.onConnect(), 2000))
  
    event.on("clientMove", async ({ client, toChannel, fromChannel, invoker }) => {
      if (!toChannel || !fromChannel) {
        if (support.isSupporter(client)) support.supportCountChange()
      }
      if (!toChannel || toChannel.id() !== config.supportChannel) return
      if (support.isSupporter(client)) {
        debug(LOGLEVEL.VERBOSE)("ignoring move event because client is supporter")
        //is supporter
      } else {
        if (invoker && !client.equals(invoker)) return //do nothing someone moved him inside
        switch (await support.requestSupport(client)) {
          case SupportRequestResponse.BLACKLISTED:
            debug(LOGLEVEL.VERBOSE)(`removing ${client.getURL()} because of blacklist`)
            const { reason } = await support.getBlacklistEntry(client)
            client.chat(`You are blacklisted from support! (reason: ${reason})`)
            return client.kickFromChannel()

          case SupportRequestResponse.OK:
            debug(LOGLEVEL.VERBOSE)(`got support request ok for ${client.getURL()}`)
            return //all ok
        }
      }
    })

  })

})