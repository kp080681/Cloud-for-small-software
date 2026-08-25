\# Small Software Cloud



\## Build Anywhere. Run Here.



\### Whitepaper v0.1



\---



\## Executive Summary



Software creation is undergoing a structural change.



AI-assisted development tools such as coding agents, AI IDEs and application generators are making it dramatically easier for individuals and small teams to create useful software.



Applications that previously required a dedicated engineering team can increasingly be built by:



\* founders

\* agencies

\* freelancers

\* small development companies

\* business teams

\* technically capable operators

\* AI-assisted builders



The cost of creating software is falling rapidly.



The cost and complexity of \*\*operating software\*\*, however, has not fallen at the same rate.



Once an application has been built, someone still has to make decisions about:



\* deployment

\* compute

\* databases

\* authentication

\* permissions

\* environment variables

\* secrets

\* networking

\* HTTPS

\* domains

\* logs

\* backups

\* redeployment

\* availability

\* security

\* scaling

\* maintenance



For a sophisticated engineering organisation, these are normal infrastructure concerns.



For a five-person company that has just built an internal quotation system with an AI coding tool, they are unnecessary complexity.



This creates a new infrastructure opportunity.



> \*\*AI builds the software. We make it run.\*\*



Small Software Cloud is an infrastructure platform designed specifically for the rapidly growing world of small, bespoke software.



Its purpose is simple:



> \*\*Take working software and make it operational.\*\*



The long-term ambition is to become:



> \*\*The home for small software.\*\*



\---



\# 1. The Small Software Shift



For most of the history of software, building custom applications was expensive.



A business wanting its own CRM, reporting system, approval workflow or operations dashboard typically needed to:



1\. hire developers,

2\. engage a software company,

3\. purchase an existing SaaS product, or

4\. abandon the idea entirely.



AI is changing that equation.



Software can increasingly be created from intent.



A founder can describe a workflow.



An agency can build a client portal.



An employee can create an internal dashboard.



A freelancer can create a specialised business application.



An existing development team can dramatically increase its output.



The result will not simply be more large software companies.



It will produce \*\*millions of smaller pieces of software\*\*.



These applications may have:



\* 3 users,

\* 20 users,

\* 100 users,

\* 500 users,



rather than millions.



Individually, each application may appear unimportant to traditional cloud providers.



Collectively, they represent an enormous infrastructure market.



\---



\# 2. Small Software



Small software is software built for a specific purpose, organisation, workflow or group of users.



Examples include:



\* lead-management systems

\* quotation tools

\* internal CRMs

\* reporting dashboards

\* customer portals

\* employee applications

\* inventory systems

\* approval workflows

\* campaign dashboards

\* commission calculators

\* project-management tools

\* scheduling systems

\* operational dashboards

\* data collection applications

\* specialised industry tools



These applications do not require hyperscale infrastructure.



They require something arguably more important:



> \*\*simple, reliable infrastructure that somebody else takes responsibility for operating.\*\*



This distinction defines the market.



\---



\# 3. The Infrastructure Gap



AI has dramatically reduced the difficulty of creating software.



It has not eliminated infrastructure.



A user may successfully create an application using an AI development tool and still encounter:



```text

Where do I deploy this?



What database should I use?



How do I configure PostgreSQL?



Where do my secrets go?



How do I configure authentication?



How do I connect a domain?



Why did the build fail?



Why is production different from local development?



Where are my logs?



How do I redeploy?



How do I back this up?



Is this secure?



Who can access the application?



What happens if it crashes?

```



Existing cloud platforms solve these problems.



But they frequently expose the underlying infrastructure concepts directly to the customer.



That is appropriate for infrastructure engineers.



It is increasingly inappropriate for the emerging generation of AI-assisted software builders.



The opportunity is therefore not simply cheaper hosting.



It is:



> \*\*removing operational complexity between working code and working software.\*\*



\---



\# 4. The Product Thesis



Small Software Cloud is not an AI application builder.



It does not compete with tools whose primary purpose is generating software.



Those tools are potential upstream partners.



The product sits immediately after creation.



```text

IDE / AI Builder

&#x20;      ↓

&#x20;    Code

&#x20;      ↓

&#x20;   GitHub

&#x20;      ↓

SMALL SOFTWARE CLOUD

&#x20;      ↓

&#x20; Running Software

```



The core promise is:



> \*\*Build anywhere. Run here.\*\*



A developer should be free to use:



\* Codex

\* Claude Code

\* Cursor

\* v0

\* Lovable

\* conventional development tools

\* future coding agents



The infrastructure layer should not care how the software was created.



If the application conforms to a supported architecture, the platform should be capable of operating it.



\---



\# 5. The Desired Experience



The ideal user interaction is deliberately simple.



```text

Connect GitHub

&#x20;      ↓

Select repository

&#x20;      ↓

Application analysed

&#x20;      ↓

Requirements detected

&#x20;      ↓

Missing configuration requested

&#x20;      ↓

Infrastructure provisioned

&#x20;      ↓

Application built

&#x20;      ↓

Application verified

&#x20;      ↓

HTTPS configured

&#x20;      ↓

APP LIVE

```



The user should not need to manually configure multiple infrastructure vendors.



For a supported application, the platform should determine as much as possible automatically.



The user should provide only information the system genuinely cannot infer.



\---



\# 6. The First Product Boundary



The first version will deliberately support a narrow application profile.



Initial technologies:



\* GitHub

\* Next.js

\* Node.js

\* PostgreSQL

\* environment variables

\* HTTPS

\* application logs

\* redeployment



This is intentionally restrictive.



The platform will initially avoid attempting to support every modern software architecture.



Examples deliberately outside the first scope include:



\* arbitrary Docker Compose workloads

\* Kubernetes

\* GPU applications

\* complex microservices

\* Java

\* .NET

\* PHP

\* arbitrary Python workloads

\* specialised message brokers

\* unusual networking requirements

\* large distributed systems



The purpose of V1 is not maximum compatibility.



The purpose is:



> \*\*exceptional reliability inside a clearly defined compatibility boundary.\*\*



A narrow platform that deploys supported software reliably is more valuable than a broad platform that works unpredictably.



\---



\# 7. Reliability Is Part of the Product



Infrastructure earns trust differently from conventional SaaS.



A user may tolerate a minor interface defect.



They will not tolerate their business application repeatedly becoming unavailable.



For Small Software Cloud, reliability is therefore a product feature.



The platform will be designed around several principles.



\### Predictable deployment



A supported repository should produce predictable results.



The same application and configuration should not randomly succeed on one deployment and fail on another.



\### Explicit state



Every deployment must have a known state.



Examples include:



```text

Analysing

Waiting for configuration

Provisioning

Building

Deploying

Verifying

Live

Failed

```



Failures must not disappear into ambiguous loading screens.



\### Recoverability



Every important platform operation must be designed with failure in mind.



If an operation stops halfway through, the system must know:



\* what completed,

\* what did not,

\* what can safely be retried,

\* what needs to be cleaned up.



\### Idempotency



Infrastructure operations should be safe to repeat whenever possible.



A retry should not accidentally create:



\* multiple databases,

\* duplicate deployments,

\* orphan resources,

\* inconsistent state.



\### Observable execution



Every meaningful infrastructure action must create a traceable event.



The platform should be able to answer:



> \*\*What exactly happened?\*\*



\### Safe failure



When something cannot be completed safely, the system should stop rather than improvise.



\---



\# 8. Performance and Latency



The platform should feel immediate even though infrastructure operations may occur asynchronously underneath it.



Two different forms of latency must be distinguished.



\## Control-plane latency



Actions such as:



\* opening dashboards

\* reading deployment state

\* viewing applications

\* checking configuration

\* reading deployment history



should feel extremely fast.



The control plane should be engineered to avoid unnecessary hops, synchronous infrastructure calls and slow dependency chains.



\## Workload latency



Once an application is live, user requests should not needlessly pass through the Small Software Cloud control plane.



Wherever possible:



```text

End User

&#x20;  ↓

Application Runtime

```



rather than:



```text

End User

&#x20;  ↓

Our Control Plane

&#x20;  ↓

Application Runtime

```



This is a fundamental architectural principle.



> \*\*The orchestration layer should not become a permanent performance tax on customer applications.\*\*



The objective is therefore not a physically impossible promise of zero latency.



The objective is:



> \*\*near-zero unnecessary platform-added latency.\*\*



\---



\# 9. Architecture Philosophy



Small Software Cloud will not initially build the physical cloud underneath the product.



Instead:



```text

OUR PRODUCT

&#x20;    ↓

OUR CONTROL PLANE

&#x20;    ↓

OUR ORCHESTRATION

&#x20;    ↓

MATURE INFRASTRUCTURE PROVIDERS

```



Existing providers may initially supply:



\* compute

\* networking

\* PostgreSQL

\* DNS

\* TLS

\* storage

\* monitoring

\* other infrastructure primitives



This allows the company to focus its early engineering effort on the layer where it can create differentiated value:



\* repository understanding

\* application detection

\* deployment orchestration

\* infrastructure provisioning

\* configuration

\* identity

\* sharing

\* troubleshooting

\* lifecycle management

\* developer experience

\* agent integration



Over time, infrastructure can move progressively in-house if scale and economics justify it.



The rule is:



> \*\*Revenue earns complexity.\*\*



\---



\# 10. Own the Control Plane Before the Compute Plane



The control plane is the brain of the platform.



It understands:



\* users

\* organisations

\* repositories

\* applications

\* configuration

\* infrastructure requirements

\* environments

\* deployments

\* resources

\* domains

\* permissions

\* usage

\* operational state



Customer applications should remain separate from the control plane.



This separation is essential for:



\* security

\* reliability

\* portability

\* infrastructure evolution



The platform should therefore be designed so that underlying providers can eventually change without requiring the product itself to be rebuilt.



> \*\*Own the control plane before owning the compute plane.\*\*



\---



\# 11. Application Understanding



One of the platform's most important capabilities will be understanding what an application requires.



A repository should not simply be treated as an arbitrary collection of files.



The platform should determine:



\* framework

\* runtime

\* package manager

\* build command

\* start command

\* environment variables

\* database dependency

\* supported services

\* incompatible dependencies

\* deployment requirements



The result should be a deployment plan.



For example:



```text

Application detected



Framework

Next.js



Runtime

Node.js



Database

PostgreSQL



Environment variables

8 detected



Missing secrets

2



Compatibility

Supported



Ready to deploy

```



This application-understanding layer can become increasingly intelligent over time.



However, critical infrastructure decisions should initially favour deterministic rules over probabilistic AI behaviour.



AI can assist.



Infrastructure correctness should not depend entirely on AI guessing correctly.



\---



\# 12. Security



Running software written by external users creates a fundamentally different risk profile from operating a normal SaaS application.



Customer code must eventually be treated as potentially hostile.



Possible behaviour includes:



\* attempting to access another customer's data

\* stealing credentials

\* consuming excessive CPU

\* consuming excessive memory

\* filling disks

\* network scanning

\* sending spam

\* cryptocurrency mining

\* denial-of-service behaviour

\* exploiting runtime vulnerabilities

\* attacking platform infrastructure



Security must therefore exist in the architecture from the beginning.



Core requirements include:



\* tenant isolation

\* workload isolation

\* encrypted secrets

\* least-privilege credentials

\* controlled networking

\* resource limits

\* build isolation

\* rate limits

\* abuse prevention

\* auditability

\* secure resource deletion

\* separation of platform and workload credentials



The company should not publicly execute arbitrary customer code until the isolation architecture has been appropriately reviewed.



Specialist security expertise should be used where necessary.



This is preferable to either:



\* pretending the risk does not exist, or

\* prematurely building a large security organisation.



\---



\# 13. The Infrastructure Abstraction



The underlying infrastructure should be replaceable.



Conceptually:



```text

Application

&#x20;    ↓

Deployment Engine

&#x20;    ↓

Infrastructure Adapter

&#x20;    ↓

Provider

```



The same principle applies to databases and other resources.



This prevents one infrastructure provider from becoming the architecture of the company itself.



Early providers are implementation choices.



Small Software Cloud is the product.



\---



\# 14. Proof Before Expansion



The platform will initially be proven on software we genuinely operate.



This avoids artificial demonstrations.



The progression is:



```text

DealUp websites

&#x20;      ↓

DealOS

&#x20;      ↓

Vantage

&#x20;      ↓

Additional test applications

&#x20;      ↓

External alpha applications

&#x20;      ↓

Paying workloads

```



Each stage introduces additional complexity.



\## DealUp websites



Tests:



\* source connection

\* framework detection

\* build

\* deployment

\* HTTPS

\* redeployment



\## DealOS



Tests:



\* application configuration

\* environment variables

\* database connectivity

\* authentication

\* persistent business usage



\## Vantage



Tests a substantially more sophisticated workload involving:



\* Next.js

\* PostgreSQL

\* authentication

\* AI workflows

\* APIs

\* notifications

\* email

\* external integrations

\* production business processes



These applications must remain ordinary applications.



No hidden platform-specific shortcuts should be added merely to make demonstrations succeed.



If the platform cannot deploy them normally, the platform needs improvement.



\---



\# 15. Bootstrapping



Small Software Cloud is intended to become a founder-controlled, capital-efficient infrastructure company.



The initial objective is not to raise a large funding round.



The initial objective is to prove that customers need the product.



The progression is:



```text

Prototype

&#x20;   ↓

Internal deployment

&#x20;   ↓

Real operational usage

&#x20;   ↓

External application

&#x20;   ↓

10 external applications

&#x20;   ↓

First paying workload

&#x20;   ↓

Meaningful MRR

&#x20;   ↓

Infrastructure expansion

```



The initial operating budget is approximately:



> \*\*₹20,000 per month\*\*



This constraint is intentional.



It encourages:



\* managed infrastructure

\* usage-based services

\* open-source software

\* AI-assisted development

\* disciplined prioritisation

\* minimal fixed overhead



It discourages:



\* premature hiring

\* owning servers too early

\* unnecessary enterprise tooling

\* large infrastructure commitments

\* speculative engineering



Capital should follow evidence.



Time passing is not evidence.



\---



\# 16. Distribution



Infrastructure products cannot depend solely on conventional paid advertising.



Distribution should begin while the platform is being developed.



The natural channels include:



\* GitHub

\* developer communities

\* AI-builder communities

\* agencies

\* freelancers

\* open-source projects

\* CLI integrations

\* APIs

\* MCP

\* AI coding agents

\* deployment case studies



The desired future mental model is:



> \*\*I built it. Now I deploy it on X.\*\*



Eventually deployment should be possible directly from the tools where software is created.



For example:



```text

User:

Deploy this.



Agent:

Application analysed.

PostgreSQL required.

2 secrets are missing.



User supplies secrets.



Agent:

Deployment complete.

https://application.example

```



The website will eventually be only one interface to the platform.



\---



\# 17. Business Model



The platform should primarily monetise workloads rather than seats.



Potential revenue sources include:



\* application runtime

\* databases

\* compute

\* storage

\* bandwidth

\* backups

\* private applications

\* premium domains

\* higher resource limits

\* operational tooling

\* security capabilities

\* AI troubleshooting

\* team capabilities



Possible future tiers may include:



\### Free



For experimentation and very small applications.



\### Builder



For individuals operating genuine applications.



\### Team / Agency



For organisations managing multiple applications.



\### Business



For workloads requiring additional reliability, resources, security or support.



Exact pricing should not be invented in advance.



Pricing must be validated against:



\* infrastructure cost

\* gross margin

\* willingness to pay

\* usage behaviour

\* customer value



\---



\# 18. Economic Discipline



Infrastructure can create dangerous economics if pricing and resource consumption are not understood.



Every workload should eventually have measurable infrastructure economics.



The platform must understand:



```text

Revenue per workload

\-

Compute

\-

Database

\-

Storage

\-

Bandwidth

\-

Third-party services

\-

Support burden

=

Workload contribution margin

```



Growth without infrastructure economics is not success.



A major company metric should therefore be:



> \*\*Infrastructure cost per active workload.\*\*



\---



\# 19. Core Metrics



The platform should avoid optimising around vanity signups.



Important metrics include:



\* successful deployments

\* deployment success rate

\* time to first deployment

\* deployment failure causes

\* active applications after 7 days

\* active applications after 30 days

\* external applications deployed

\* paying workloads

\* applications per organisation

\* infrastructure cost per workload

\* gross margin

\* free-to-paid conversion

\* MRR

\* expansion revenue

\* reliability

\* platform-added latency



One particularly important metric is:



> \*\*How often does a supported application deploy successfully without human infrastructure intervention?\*\*



That number should move relentlessly toward 100%.



\---



\# 20. Quality Standard



The platform is not successful merely because an application eventually deploys.



The experience must become dependable enough that customers trust important software to it.



The quality ambition is therefore:



\### Supported applications deploy predictably.



\### Live applications remain reliably available.



\### Control-plane actions feel immediate.



\### Platform-added runtime latency is negligible.



\### Failures are understandable.



\### Operations can be safely retried.



\### Secrets remain protected.



\### Customer workloads remain isolated.



\### Recovery is designed rather than improvised.



\### Every important operation is observable.



The platform should favour:



> \*\*fewer capabilities implemented exceptionally well\*\*



over:



> \*\*many capabilities implemented adequately.\*\*



\---



\# 21. What We Are Not Building



Small Software Cloud is not:



\* an AI coding assistant

\* an IDE

\* a no-code platform

\* another Lovable

\* another Cursor

\* another CRM

\* an AWS clone

\* a Kubernetes dashboard

\* a generic hosting reseller



Its responsibility starts when useful software exists.



> \*\*AI builds software. We make it operational.\*\*



\---



\# 22. Conditions That Could Disprove the Thesis



The company must remain willing to change direction if reality contradicts the thesis.



Warning conditions include:



\* builders do not experience meaningful deployment pain

\* existing platforms already solve the problem sufficiently

\* external users are unwilling to trust the platform with real applications

\* users will not pay enough to support infrastructure economics

\* infrastructure costs prevent acceptable gross margins

\* required security investment becomes incompatible with bootstrapping

\* application diversity makes reliable automation impractical

\* platform-added complexity becomes greater than the complexity removed



These should be treated as information, not failure.



\---



\# 23. Long-Term Evolution



Infrastructure ownership should increase only when justified.



\### Stage 1 - Managed infrastructure



Existing providers execute most infrastructure.



Our value is orchestration and experience.



\### Stage 2 - Runtime control



More deployment and workload control moves into our platform.



\### Stage 3 - Isolation infrastructure



Containers or microVM technology becomes appropriate where economics and security justify it.



\### Stage 4 - Regional infrastructure



Workloads can be placed across optimised infrastructure regions.



\### Stage 5 - Small Software Cloud



A specialised cloud architecture designed around the economics and operational patterns of small software.



There is no requirement to reach every stage.



The next layer should be built only when the existing business earns it.



\---



\# 24. Agent-Native Infrastructure



Software development is increasingly becoming agent-driven.



Infrastructure should therefore be designed for both humans and machines.



Every major operation should eventually be available through:



\* web interface

\* CLI

\* REST API

\* MCP

\* agent tools



The product architecture should make these interfaces clients of the same underlying control plane.



The future interaction is not:



> Open a dashboard and configure infrastructure.



It is:



> \*\*Deploy this.\*\*



The system handles everything it safely can.



\---



\# 25. The Long-Term Vision



The ultimate opportunity is larger than deployment.



If increasingly large amounts of business software are created dynamically, somebody needs to provide its operational home.



That layer can eventually include:



```text

Deployment

Runtime

Database

Authentication

Permissions

Storage

Secrets

Domains

Backups

Logs

Monitoring

Usage

Billing

Security

Troubleshooting

Agent interfaces

```



Not because every feature must exist immediately.



But because these are the recurring operational needs of software.



The platform that makes these capabilities radically easier for small software can become a foundational layer of the AI software economy.



The ambition is:



> \*\*The home for small software.\*\*



\---



\# 26. Operating Principles



The company will use the following principles to control product and engineering decisions.



\## Build anywhere. Run here.



Do not compete unnecessarily with the software creation ecosystem.



\## Reliability before breadth.



A narrow platform that works exceptionally well is better than broad unreliable support.



\## Revenue earns complexity.



Infrastructure ownership expands only when customer economics justify it.



\## Own the control plane before owning the compute plane.



Control, orchestration and experience are the first source of differentiation.



\## Security is architecture.



Security cannot be bolted on after arbitrary customer code is already running.



\## Supported means supported.



If the platform claims compatibility, deployment should be highly predictable.



\## Reject unsupported workloads clearly.



Do not hide incompatibility behind unreliable automation.



\## Keep customer software portable.



Applications should remain ordinary applications rather than becoming dependent on proprietary hacks.



\## Automate repeatable infrastructure work.



Human intervention should progressively disappear from normal deployments.



\## Measure infrastructure economics.



Growth must produce a sustainable company.



\## Build what we need.



Use genuine applications to prove the infrastructure.



\## Prove it on ourselves.



The platform earns credibility through real usage before claims.



\## Open it to others.



Internal proof must ultimately become external value.



\## Let customers finance the cloud that follows.



Capital follows evidence.



\---



\# Conclusion



AI is changing who can create software.



That shift will produce vastly more software than the traditional development ecosystem was built to accommodate.



Much of it will be small.



Much of it will be specialised.



Much of it will never require hyperscale infrastructure.



But all of it must run somewhere.



Small Software Cloud exists to become that operational layer.



The company does not begin by building a new cloud.



It begins by removing everything unnecessary between working software and reliable software.



It proves that capability on its own applications.



It opens the platform to other builders.



It earns revenue.



It progressively owns more of the infrastructure only when doing so creates genuine economic or technical advantage.



The guiding principle is:



> \*\*Build what we need. Prove it on ourselves. Open it to others. Let customers finance the cloud that follows.\*\*



And the promise to the builder remains:



> \*\*Build Anywhere. Run Here.\*\*



