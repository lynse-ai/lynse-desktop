import { describe, expect, it } from "vitest";
import { browsingGraph, browsableTopics, topicChanges, topicDetails } from "./wiki-browse";
import { useWikiBrowser } from "./wiki-browser-state";
import type { WikiTopic, KnowledgeGraph } from "./types";
const topic = (id: string, patch: Partial<WikiTopic> = {}): WikiTopic => ({ id, title: "同名项目", purpose: "", notes: "人工补充", candidate:null, pinned: false, excluded: false, stale: false, error: "", published: { id:"v1",markdown:"正文",citations:[{id:"meeting",kind:"meeting_summary",revision:"r1",quote:"证据"}],review:"auto_validated",fingerprint:"fixture",reviewedAt:"",createdAt:"2026-10-23", changes:[{id:"change",text:"发生变化",createdAt:"2026-10-23",citations:[]}] }, ...patch });
describe("Wiki browsing", () => {
  it("keeps stable same-name topics separate and hides drafts, excluded and out-of-range topics", () => {
    const topics = [topic("a"),topic("b"),topic("out",{inScope:false}),topic("excluded",{excluded:true}),topic("draft",{published:null})];
    expect(browsableTopics(topics).map(topic => topic.id)).toEqual(["a","b"]);
    const graph = browsingGraph(topics, {edges:[{id:"valid",source:"wiki:a",target:"wiki:b",kind:"shared_source"},{id:"invalid",source:"wiki:a",target:"wiki:out",kind:"related"}]} as KnowledgeGraph);
    expect(graph.nodes).toHaveLength(2); expect(graph.edges.map(edge=>edge.id)).toEqual(["valid"]);
  });
  it("shows unique changes only from confirmed or automatically validated history", () => {
    const current=topic("a"); current.history=[{...current.published!,id:"v0"},{...current.published!,id:"draft",review:"",changes:[{id:"bad",text:"未确认",createdAt:"2026-10-24",citations:[]}]}];
    expect(topicChanges(current).map(change=>change.id)).toEqual(["change"]);
  });
  it("discloses details from shared sources without treating co-occurrence as a business relation", () => {
    const graph={nodes:[{id:"person",kind:"entity",subtype:"person",citations:topic("a").published!.citations},{id:"outside",kind:"event",subtype:"task",citations:[{id:"other"}]}]} as KnowledgeGraph;
    expect(topicDetails(topic("a"),graph).map(node=>node.id)).toEqual(["person"]);
  });
  it("restores selection and camera within an account and clears them across account changes", () => {
    const state=useWikiBrowser.getState(); state.setScope("one"); state.update({selectedId:"a",search:"预算",camera:{scale:1.4,x:30,y:15,yaw:0,pitch:0}});
    state.setScope("one"); expect(useWikiBrowser.getState().browse.selectedId).toBe("a");
    state.setScope("two"); expect(useWikiBrowser.getState().browse).toEqual({selectedId:null,search:""});
  });
});
