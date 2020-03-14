///<reference path="node_modules/sinusbot/typings/global.d.ts" />

import type { Client } from "sinusbot/typings/interfaces/Client"
import type { Command } from "sinusbot/typings/external/command"


type SupportRoles = SupportRole[]
interface SupportRole {
  sgid: string[]
  permBlacklist: boolean
  jurisdiction: string
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

registerPlugin<{
  supportChannel: string
  command: string
  roles: SupportRoles
  DEBUGLEVEL: number
}>({
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
    title: "Chat Command name (default: support)",
    default: "support"
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
      type: "checkbox" as const,
      title: "allow support blacklist?",
      name: "permBlacklist",
      default: false
    }, {
      type: "string" as const,
      title: "jurisdiction of this role",
      name: "jurisdiction",
      default: "NO_JURISDICTION_GIVEN"
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
    roles: SupportRoles
    storage: StorageProvider
    cmd: string
  }

  type SupportQueue = Queue[]

  class Support {

    readonly roles: SupportRoles
    readonly backend = require("backend")
    readonly format = require("format")
    readonly cmd: Command.CommandGroup
    private readonly store: StorageProvider
    private readonly queue: SupportQueue = []
    private readonly pendingRequest: RequestChallenge[] = []

    constructor(config: SupportConfig) {
      this.roles = config.roles
      this.store = config.storage
      let { cmd } = config
      if (typeof cmd !== "string" || cmd.length < 1 || (/\s/).test(cmd)) {
        engine.log(`Invalid command name provided '${cmd}' using fallback name "sup"`)
        cmd = "support"
      }
      this.cmd = require("command").createCommandGroup(cmd)
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
        .checkPermission(client => this.clientInChallengeState(client, RequestChallengeState.ASK_INQUIRY))
        .addArgument(args => args.number.setName("inquiry").integer().max(this.roles.length - 1).min(0))
        .exec((client, args) => {
          const challenge = this.clientGetChallenge(client)
          if (!challenge) return client.chat("Whooops something went wrong! (Challenge not found)")
          challenge.setInquiry(args.inquiry)
        })
      this.cmd
        .addCommand("describe")
        .help("describes your support issue")
        .checkPermission(client => this.clientInChallengeState(client, RequestChallengeState.DESCRIBE))
        .addArgument(args => args.rest.setName("issue"))
        .exec((client, args) => {
          const challenge = this.clientGetChallenge(client)
          if (!challenge) return client.chat("Whooops something went wrong! (Challenge not found)")
          challenge.setIssue(args.issue)
        })
    }

    /**
     * retrieves the challenge of the given client
     * @param client the client to retrieve the state for
     */
    clientGetChallenge(client: Client) {
      return this.pendingRequest.find(req => client.equals(req.client))
    }

    /**
     * checks wether a client is in a challenge state
     * @param client the client to check
     * @param state the state to check if he is in
     */
    clientInChallengeState(client: Client, state: RequestChallengeState) {
      const challenge = this.clientGetChallenge(client)
      if (!challenge) return false
      return challenge.state === state
    }

    /**
     * retrieves a list of clients which are supporters and online
     * @param jurisdiction requested jurisdiction
     */
    getOnlineSupporters(jurisdiction?: string) {
      return this.backend.getClients()
        .filter(client => this.isSupporter(client, jurisdiction))
        .map(client => ({
          client,
          roles: this.getClientSupportRoles(client)
        }))
    }


    /**
     * retrieves support roles of a specific Client
     * @param client the client to check
     * @param jurisdiction the jurisdiction to get
     */
    getClientSupportRoles(client: Client, jurisdiction?: string): SupportRoles {
      const roles = this.roles
        .filter(role => this.inGroup(client, role.sgid))
      if (!jurisdiction) return roles
      return roles.filter(role => role.jurisdiction === jurisdiction)
    }

    /**
     * checks wether a client is in a support group
     * of the requested jurisdiction
     * @param client the client which should be checked
     * @param jurisdiction the jurisdiction he should be in
     */
    isSupporter(client: Client, jurisdiction?: string) {
      return this.getClientSupportRoles(client, jurisdiction).length > 0
    }
  
    /**
     * checks if the client is in one of the groups
     * @param client the client to check
     * @param groups the groups which should be checked
     */
    private inGroup(client: Client, groups: string[]) {
      return client.getServerGroups().map(g => g.id()).some(sgid => groups.includes(sgid))
    }

    private getChallengeComplete(challenge: RequestChallenge) {
      this.queue.push(new Queue({
        uid: challenge.client.uid(),
        nick: challenge.client.nick(),
        issue: <string>challenge.result.issue,
        role: <SupportRole>challenge.result.role,
        support: this
      }))
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
  }


  interface QueueConfig {
    uid: string
    nick: string
    role: SupportRole
    issue: string
    support: Support
  }


  class Queue {

    private uid: string
    private nick: string
    private role: SupportRole
    private issue: string
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
      return Boolean(this.findClient())
    }

    /**
     * gets the client object if the given client is online
     */
    findClient() {
      return this.parent.backend.getClients()
        .find(client => client.uid() === this.uid)
    }

    /**
     * gets a list of available supporters for this case
     */
    supporters() {
      return this.parent.getOnlineSupporters(this.role.jurisdiction)
    }
  }


  abstract class Challenge<T extends number> {

    private stateObservers: ((event: {from: T, to: T }) => void)[] = []
    private cbs: (() => void)[] = []
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
    private setState(state: number) {
      const from = this.challengeState
      this.challengeState = <T>state
      this.stateObservers.forEach(cb => cb({ from, to: <T>state }))
    }

    /**
     * sets the callbacks which are being executed in order
     * @param cbs 
     */
    protected setCallbacks(cbs: (() => void)[]) {
      this.cbs = cbs
    }
  
    /* runs the next available challenge */
    protected next() {
      this.setState(this.challengeState + 1)
      this.challenge()
    }

    /* starts the current challenge */
    challenge() {
      if (typeof this.cbs[this.challengeState] !== "function")
        throw new Error(`No function available to execute next`)
      this.cbs[this.challengeState]()
    }

  }

  interface RequestChallengeConfig {
    client: Client,
    support: Support
    done: (challenge: RequestChallenge) => void
  }

  interface RequestChallengeResult {
    role: SupportRole
    issue: string
  }

  enum RequestChallengeState {
    ASK_INQUIRY,
    DESCRIBE,
    DONE
  }


  class RequestChallenge extends Challenge<RequestChallengeState> {
    readonly client: Client
    private readonly parent: Support
    result: Partial<RequestChallengeResult> = {}
    private readonly done: (challenge: RequestChallenge) => void

    constructor(config: RequestChallengeConfig) {
      super(RequestChallengeState.ASK_INQUIRY)
      this.setCallbacks([
        this.checkInquiry.bind(this),
        this.describeIssue.bind(this),
        this.complete.bind(this)
      ])
      this.client = config.client
      this.parent = config.support
      this.done = config.done
    }

    private checkInquiry() {
      this.client.chat(`What inquiry do you have?`)
      let res = ""
      this.parent.roles.forEach((role, index) => {
        const cmd = this.parent.format.bold(`${this.parent.cmd.getFullCommandName()} request ${index}`)
        res += `\n${cmd}\n${role.jurisdiction} - ${role.description}\n`
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
      if (!role) return this.challenge()
      this.result.role = role
      return this.next()
    }

    setIssue(issue: string) {
      if (issue.length < 10) {
        this.client.chat("Your issue description seems kinda short! Please try again!")
        return this.challenge()
      }
      this.result.issue = issue
      return this.next()
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
      roles: config.roles,
      storage: new BaseStore(),
      cmd: config.command
    })   
    await support.setup("")
  
  
    event.on("clientMove", async ({ client, toChannel, invoker }) => {
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