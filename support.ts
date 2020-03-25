///<reference path="node_modules/sinusbot/typings/global.d.ts" />

import type { Client } from "sinusbot/typings/interfaces/Client"
import type { Command } from "sinusbot/typings/external/command"


type SupportRoles = SupportRole[]
interface SupportRole {
  cid: string
  sgid: string[]
  permBlacklist: boolean
  permViewTickets: boolean
  permDeveloper: boolean
  department: string
  description: string
}


interface StorageProviderBlackListEntry {
  uid: string
  until: number
  reason: string
  invoker: string
}


interface StorageProviderTicketEntry {
  id: number
  status: "open"|"closed"
  issuer: string
  issue: string
  created: number
  role: string
  resolvedText: string
  resolvedBy: string
}


interface StorageProvider {

  /**
   * an incremental store version
   * which validates if the store can be used with the current script
   */
  readonly version: number

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

  /**
   * creates a new ticket
   * @param entry data which should get added to the store
   * @returns returns the ticket id
   */
  addTicket(entry: Omit<StorageProviderTicketEntry, "id">): Promise<number>

  /**
   * creates a new ticket
   * @param entry data which should get added to the store
   * @returns returns the ticket id
   */
  updateTicket(entry: StorageProviderTicketEntry): Promise<void>

  /**
   * retrieves a ticket by its property value
   * @param prop the key to search for
   * @param value the value it should match
   */
  getTicketBy<T extends keyof StorageProviderTicketEntry>(prop: T, value: StorageProviderTicketEntry[T]): Promise<StorageProviderTicketEntry[]>

  /**
   * removes a single ticket
   * @param id ticket id to remove
   */
  removeTicket(id: number): Promise<void>

  /**
   * wipes the whole store
   */
  reset(): Promise<void>
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
      title: "allow access to command <!support blacklist>?",
      name: "permBlacklist",
      default: false
    }, {
      type: "checkbox" as const,
      title: "allow access to command <!support tickets>",
      name: "permViewTickets",
      default: false
    }, {
      type: "checkbox" as const,
      title: "allow access to command <!support dev> (FOR DEVELOPMENT ONLY)",
      name: "permDeveloper",
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


  ///////////////////////////////////////////////////////////
  ///                      ROLE                           ///
  ///////////////////////////////////////////////////////////


  class Role {

    readonly isValid: boolean
    private cid: string
    private sgid: string[]
    private perms: Record<string, boolean> = {}
    private backend = require("backend")
    readonly department: string
    readonly description: string

    constructor(role: SupportRole & { isValid?: boolean }) {
      this.cid = role.cid
      this.sgid = role.sgid
      this.department = role.department
      this.description = role.description
      this.setPerm("blacklist", role.permBlacklist)
      this.setPerm("tickets", role.permViewTickets)
      this.setPerm("developer", role.permDeveloper)
      this.isValid = role.isValid || role.isValid === undefined
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

    /**
     * retrieves a serializeable identifier
     * in this case the department id
     */
    serialize() {
      return this.department
    }

    static deleted() {
      return Role.empty({
        department: "_DELETED_",
        description: "_DELETED_ROLE_"
      })
    }

    /**
     * creates a new empty role
     */
    static empty(prefill: Partial<SupportRole> = {}) {
      return new Role({
        cid: "0",
        sgid: [],
        department: "_EMPTY_",
        description: "_EMPTY_",
        permBlacklist: false,
        permViewTickets: false,
        permDeveloper: false,
        ...prefill,
        isValid: false
      })
    }
  }

  ///////////////////////////////////////////////////////////
  ///                   BaseStore                         ///
  ///////////////////////////////////////////////////////////

  interface BaseStoreConfig {
    ticketId: number
  }

  class BaseStore implements StorageProvider {

    private namespace: string = ""
    readonly store = require("store")
    readonly version = 1

    private get(name: "blacklist"): StorageProviderBlackListEntry[]
    private get(name: "tickets"): StorageProviderTicketEntry[]
    private get(name: "config"): BaseStoreConfig
    private get(name: string) {
      return this.store.getInstance(`${this.namespace}${name}`)
    }

    private set(name: "blacklist", value: StorageProviderBlackListEntry[]): void
    private set(name: "tickets", value: StorageProviderTicketEntry[]): void
    private set(name: "config", value: BaseStoreConfig): void
    private set(name: string, value: any): void {
      this.store.setInstance(`${this.namespace}${name}`, value)
    }

    get storeBlacklist() {
      return `${this.namespace}blacklist`
    }

    static updateConfiguration(config: Partial<BaseStoreConfig> = {}): BaseStoreConfig {
      return {
        ticketId: 1,
        ...config
      }
    }

    private getTicketId() {
      const config = this.get("config")
      const id = config.ticketId++
      this.set("config", config)
      return id
    }

    setup(namespace: string) {
      this.namespace = namespace
      if (!Array.isArray(this.get("blacklist"))) this.set("blacklist", [])
      if (!Array.isArray(this.get("tickets"))) this.set("tickets", [])
      this.set("config", BaseStore.updateConfiguration(this.get("config")))
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

    addTicket(entry: Omit<StorageProviderTicketEntry, "id">) {
      const id = this.getTicketId()
      this.set("tickets", [...this.get("tickets"), { id, ...entry }])
      return Promise.resolve(id)
    }

    updateTicket(entry: StorageProviderTicketEntry) {
      this.set("tickets", this.get("tickets").map(ticket => ticket.id === entry.id ? entry : ticket))
      return Promise.resolve()
    }

    removeTicket(id: number) {
      this.set("tickets", this.get("tickets").filter(ticket => ticket.id !== id))
      return Promise.resolve()
    }

    getTicketBy(prop: keyof StorageProviderTicketEntry, value: string|number) {
      return Promise.resolve(this.get("tickets").filter(ticket => ticket[prop] === value))
    }

    reset() {
      this.set("blacklist", [])
      this.set("tickets", [])
      this.set("config", BaseStore.updateConfiguration())
      return Promise.resolve()
    }

  }


  ///////////////////////////////////////////////////////////
  ///                   Ticket                            ///
  ///////////////////////////////////////////////////////////

  class Ticket {
    
    id: number = 0
    issuer: string = ""
    issue: string = ""
    role: Role = Role.empty()
    created: number = 0
    status: "open"|"closed" = "open"
    resolvedBy: string|undefined
    resolvedText: string = "_EMPTY_"

    /**
     * sets the identifier for the client which started the request
     * @param uid 
     */
    setIssuer(uid: string) {
      this.issuer = uid
      return this
    }

    /**
     * sets the ticket description
     * @param issue text which describes the issue
     */
    setIssue(issue: string) {
      this.issue = issue
      return this
    }

    /**
     * sets the role which handles this request
     * @param role assigns a role to the ticket
     */
    setRole(role: Role) {
      this.role = role
      return this
    }

    /**
     * sets the creation date of the ticket
     * @param date 
     */
    setCreated(date: number) {
      this.created = date
      return this
    }

    /**
     * closes this ticket and sets a reason
     * @param uid the client which resolved the issue 
     * @param text text 
     */
    closeTicket(uid: string, text: string) {
      this.status = "closed"
      this.resolvedBy = uid
      this.resolvedText = text
      return this
    }

    /**
     * checks if all necessary fields have been set
     */
    isValid() {
      return (
        this.issuer.length > 0 &&
        this.issue.length > 0 &&
        this.role.isValid &&
        this.created > 0
      )
    }

    /** returns serialized data */
    serialize() {
      return {
        id: this.id,
        issuer: this.issuer,
        issue: this.issue,
        created: this.created,
        role: this.role ? this.role.serialize() : undefined,
        status: this.status,
        resolvedBy: this.resolvedBy,
        resolvedText: this.resolvedText
      }
    }

    static fromStore(entry: StorageProviderTicketEntry, support: Support) {
      const ticket = new Ticket()
      ticket.setCreated(entry.created)
      ticket.setIssue(entry.issue)
      ticket.setIssuer(entry.issuer)
      let role = support.getRoleByDepartment(entry.role)
      if (!role) role = Role.deleted()
      ticket.setRole(role)
      return ticket
    }
  }


  ///////////////////////////////////////////////////////////
  ///                   Support                           ///
  ///////////////////////////////////////////////////////////

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

    readonly REQUIRED_STORE_VERSION = 1
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
     * retrieves a role by its department name
     * @param department name of the department
     */
    getRoleByDepartment(department: string) {
      return this.roles.find(role => role.department === department)
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
      if (this.store.version !== this.REQUIRED_STORE_VERSION)
        throw new Error(`Could not initialize Support Script! Required Store version is v${this.REQUIRED_STORE_VERSION} but installed is v${this.store.version}`)
      await this.store.setup(namespace)
      const tickets = await this.store.getTicketBy("status", "open")
      tickets.forEach(t => {
        const ticket = Ticket.fromStore(t, this)
        if (!ticket.isValid()) return debug(LOGLEVEL.INFO)(`Ignoring invalid Ticket with id ${t.id}!`)
        this.addTicket(ticket)
      })
      this.cmd.help("manages support requests")
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
      this.cmd
        .addCommand("dev")
        .help("developer features (not for productive environment!)")
        .checkPermission(client => this.hasPermission(client, "developer"))
        .addArgument(arg => arg.number.setName("action").positive().integer())
        .exec(async (client, { action }: { action: number }, reply) => {
          /**
           * 001 - reset store
           * 002 - 
           * 004 - 
           * 008 - 
           * 016 - 
           * 032 - 
           * 064 - 
           * 128 - 
           */
          if (action && 0x01 === 1) {
            debug(LOGLEVEL.VERBOSE)("0x01: RESETTING STORE")
            reply("0x01: Store has been resetted...")
          }
          reply("done")
        })
      this.cmd
        .addCommand("tickets")
        .help("gets status of all tickets")
        .checkPermission(client => this.hasPermission(client, "tickets"))
        .addArgument(args => args.string.setName("status").optional("any").whitelist(["any", "closed", "open"]).forceLowerCase())
        .exec(async (client, { status }: { status: string }, reply) => {
          if (["any", "open"].includes(status)) {
            reply(`There are ${this.queue.length} open ticket${this.queue.length === 1 ? "" : "s"}!`)
            //show open tickets
            this.queue.forEach(({ ticket }) => {
              const headline = `${this.format.bold(ticket.id.toString())} by client with uid ${ticket.issuer} on ${new Date(ticket.created)}`
              reply(`\n${headline}\n\n${ticket.issue}`)
            })
          }
          if (["any", "closed"].includes(status)) {
            //show closed tickets
            const tickets = await this.store.getTicketBy("status", "closed")
            reply(`There are ${tickets.length} closed ticket${tickets.length === 1 ? "" : "s"}!`)
            tickets.forEach(ticket => {
              const headline = `${this.format.bold(ticket.id.toString())} by client with uid ${ticket.issuer} on ${new Date(ticket.created)}`
              const caption = `Solved by uid ${ticket.resolvedBy} with text\n${ticket.resolvedText}`
              reply(`\n${headline}\n${caption}\n\n${ticket.issue}`)
            })
          }
        })
    }

    /**
     * checks if a specific client has certain permission
     */
    hasPermission(client: Client, permission: string) {
      debug(LOGLEVEL.VERBOSE)("hasPermission?", client.uid(), permission)
      return this.getClientSupportRoles(client).some(role => role.getPerm(permission))
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
      this.pendingRequest.slice(this.pendingRequest.indexOf(challenge), 1)
      this.addTicket(challenge.ticket)
    }

    /**
     * adds a ticket to queue and starts challenge
     * @param ticket the ticket to add to the queue
     * @returns retrieves the added queue entry
     */
    private addTicket(ticket: Ticket) {
      const queue = new Queue({ ticket, support: this })
      this.queue.push(queue)
      this.getOnlineSupporters(ticket.role?.department).forEach(({ client }) => {
        const challenge = new SupportResponseChallenge({
          support: this, queue, uid: client.uid()
        })
        this.addChallengeQueue(client.uid(), challenge)
      })
      return queue
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

    /**
     * saves the current state to store
     */
    saveAll() {
      return Promise.all(
        this.queue
          .filter(queue => queue.ticket.isValid())
          .map(queue => this.store.updateTicket(<StorageProviderTicketEntry>queue.ticket.serialize()))
      )
    }
  }


  ///////////////////////////////////////////////////////////
  ///                   Queue                             ///
  ///////////////////////////////////////////////////////////

  interface QueueConfig {
    ticket: Ticket
    support: Support
  }


  class Queue {

    readonly ticket: Ticket
    private parent: Support

    constructor(config: QueueConfig) {
      this.ticket = config.ticket
      this.parent = config.support
    }

    /** serializes data to be able to save it */
    serialize() {
      return {
        ticket: this.ticket.serialize()
      }
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
      return this.parent.getClient(this.ticket.issuer)
    }

    /**
     * gets a list of available supporters for this case
     */
    supporters() {
      return this.parent.getOnlineSupporters(this.ticket.role.department)
    }
  }



  ///////////////////////////////////////////////////////////
  ///                   Challenge                         ///
  ///////////////////////////////////////////////////////////

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



  ///////////////////////////////////////////////////////////
  ///                 RequestChallenge                    ///
  ///////////////////////////////////////////////////////////

  interface RequestChallengeConfig {
    client: Client,
    support: Support
    done: (challenge: RequestChallenge) => void
  }

  enum RequestChallengeState {
    ASK_INQUIRY,
    DESCRIBE_ISSUE,
    DONE
  }


  class RequestChallenge extends Challenge<RequestChallengeState> {
    readonly client: Client
    private readonly parent: Support
    ticket: Ticket = new Ticket()
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
      this.ticket.setCreated(Date.now())
      this.client.chat("Your issue has been forwarded to an available Supporter!")
      this.done(this)
    }

    setInquiry(index: number) {
      const role = this.parent.roles[index]
      if (!role) return this.nextState(RequestChallengeState.ASK_INQUIRY)
      this.ticket.setRole(role)
      return this.nextState(RequestChallengeState.DESCRIBE_ISSUE)
    }

    setIssue(issue: string) {
      if (issue.length < 10) {
        this.client.chat("Your issue description seems kinda short! Please try again!")
        return this.nextState(RequestChallengeState.DESCRIBE_ISSUE)
      }
      this.ticket.setIssue(issue)
      return this.nextState(RequestChallengeState.DONE)
    }
  
  }


  ///////////////////////////////////////////////////////////
  ///             SupportResponseChallenge                ///
  ///////////////////////////////////////////////////////////

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
      let request = `\nNew support request from [URL=${client.getURL()}]${client.name()}[/URL] with issue:\n${this.parent.format.italic(this.queue.ticket.issue)}\n`
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
      const channel = this.queue.ticket.role.getChannel()
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