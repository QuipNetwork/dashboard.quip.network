Work on Linear issue QUI-638:

<issue identifier="QUI-638">
<title>Derive and clean up an architecture for the dashboard.quip.network + indexer</title>
<description>
Derive current architecture for dashboard.quip.network and the indexer:

* Does the database make sense?
* Does the chain lookup pattern make sense? can we make improvements on that? 
* Right now we access some things through the miner, and some through the chain, the codebase around that is kind of a mess of monkey patching. CAn we clean this up? What is the best way to harmonize quip-miner v. quip-validator access? Would it make sense to have the quip-miner just shim all the necessary parts of the validator access and you access via that mechanism? 
* General improvements on how to build out this site would be helpful, both for UI (no paging right now, just really long lists, no search, etc) and for tech stack. 
</description>
<team name="Quip Network"/>
<label>Improvement</label>
<project name="Quip Blockchain">Our blockchain implementation</project>
</issue>
