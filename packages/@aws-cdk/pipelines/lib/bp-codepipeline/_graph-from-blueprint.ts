import { Blueprint, FileSet, StackAsset, StackDeployment, StageDeployment, Step, Wave } from '../blueprint';
import { Graph, GraphNode, GraphNodeCollection } from '../private/graph';
import { AssetType } from '../types';
import { CodePipelineSource } from './codepipeline-source';

export interface GraphFromBlueprintProps {
  readonly selfMutation?: boolean;
}

/**
 * Logic to turn the deployment blueprint into a graph
 *
 * This code makes all the decisions on how to lay out the CodePipeline
 */
export class GraphFromBlueprint {
  public readonly graph: AGraph = Graph.of('', { type: 'group' });
  public readonly cloudAssemblyFileSet: FileSet;

  private readonly added = new Map<Step, AGraphNode>();
  private readonly assetNodes = new Map<string, AGraphNode>();
  private readonly synthNode: AGraphNode;
  private readonly selfMutateNode?: AGraphNode;
  private lastPreparationNode: AGraphNode;
  private _fileAssetCtr = 0;
  private _dockerAssetCtr = 0;

  constructor(blueprint: Blueprint, props: GraphFromBlueprintProps = {}) {
    this.synthNode = this.addBuildStep(blueprint.synthStep);
    if (this.synthNode.data?.type === 'step') {
      this.synthNode.data.isBuildStep = true;
    }
    this.lastPreparationNode = this.synthNode;

    const cloudAssembly = blueprint.synthStep.primaryOutput?.primaryOutput;
    if (!cloudAssembly) {
      throw new Error(`The synth step must produce the cloud assembly artifact, but doesn't: ${blueprint.synthStep}`);
    }

    this.cloudAssemblyFileSet = cloudAssembly;

    if (props.selfMutation) {
      const stage: AGraph = Graph.of('UpdatePipeline', { type: 'group' });
      this.graph.add(stage);
      this.selfMutateNode = GraphNode.of('SelfMutate', { type: 'self-update' });
      stage.add(this.selfMutateNode);

      this.selfMutateNode.dependOn(this.synthNode);
      this.lastPreparationNode = this.selfMutateNode;
    }

    const waves = blueprint.waves.map(w => this.addWave(w));

    // Make sure the waves deploy sequentially
    for (let i = 1; i < waves.length; i++) {
      waves[i].dependOn(waves[i - 1]);
    }
  }

  public isSynthNode(node: AGraphNode) {
    return this.synthNode === node;
  }

  private addBuildStep(step: Step) {
    return this.addAndRecurse(step, this.topLevelGraph('Build'));
  }

  private addWave(wave: Wave): AGraph {
    // If the wave only has one Stage in it, don't add an additional Graph around it
    const retGraph: AGraph = wave.stages.length === 1
      ? this.addStage(wave.stages[0])
      : Graph.of(wave.id, { type: 'group' }, wave.stages.map(s => this.addStage(s)));

    this.addPrePost(wave.pre, wave.post, retGraph);
    retGraph.dependOn(this.lastPreparationNode);

    return retGraph;
  }

  private addStage(stage: StageDeployment): AGraph {
    const retGraph: AGraph = Graph.of(stage.stageName, { type: 'group' });

    const stackGraphs = new Map<StackDeployment, AGraph>();

    for (const stack of stage.stacks) {
      const stackGraph: AGraph = Graph.of(stack.stackName, { type: 'stack-group', stack });
      const prepare: AGraphNode = GraphNode.of('Prepare', { type: 'prepare', stack });
      const deploy: AGraphNode = GraphNode.of('Deploy', { type: 'execute', stack });

      stackGraph.add(prepare, deploy);
      deploy.dependOn(prepare);
      stackGraphs.set(stack, stackGraph);

      // Depend on Cloud Assembly
      const cloudAssembly = stack.customCloudAssembly?.primaryOutput ?? this.cloudAssemblyFileSet;
      prepare.dependOn(this.addAndRecurse(cloudAssembly.producer, retGraph));

      // Depend on Assets
      // FIXME: Custom Cloud Assembly currently doesn't actually help separating
      // out templates from assets!!!
      for (const asset of stack.requiredAssets) {
        const assetNode = this.publishAsset(asset);
        prepare.dependOn(assetNode);
      }
    }

    for (const stack of stage.stacks) {
      for (const dep of stack.dependsOnStacks) {
        stackGraphs.get(stack)?.dependOn(stackGraphs.get(dep)!);
      }
    }

    this.addPrePost(stage.pre, stage.post, retGraph);

    return retGraph;
  }

  private addPrePost(pre: Step[], post: Step[], parent: AGraph) {
    const currentNodes = new GraphNodeCollection(parent.nodes);
    for (const p of pre) {
      const preNode = this.addAndRecurse(p, parent);
      currentNodes.dependOn(preNode);
    }
    for (const p of post) {
      const postNode = this.addAndRecurse(p, parent);
      postNode.dependOn(...currentNodes.nodes);
    }
  }

  private topLevelGraph(name: string): AGraph {
    let ret = this.graph.tryGetChild(name);
    if (!ret) {
      ret = new Graph<GraphAnnotation>(name);
      this.graph.add(ret);
    }
    return ret as AGraph;
  }

  private addAndRecurse(step: Step, parent: AGraph) {
    const previous = this.added.get(step);
    if (previous) { return previous; }

    const node: AGraphNode = GraphNode.of(step.id, { type: 'step', step });

    // If the step is a source step, change the parent to a special "Source" stage
    // (CodePipeline wants it that way)
    if (step instanceof CodePipelineSource) {
      parent = this.topLevelGraph('Source');
    }

    parent.add(node);
    this.added.set(step, node);

    for (const dep of step.dependencySteps) {
      const producerNode = this.addAndRecurse(dep, parent);
      node.dependOn(producerNode);
    }

    return node;
  }

  private publishAsset(stackAsset: StackAsset): AGraphNode {
    const assetsGraph = this.topLevelGraph('Assets');

    const assetNode = this.assetNodes.get(stackAsset.assetId);
    if (assetNode) {
      const data = assetNode.data;
      if (data?.type !== 'publish-assets') {
        throw new Error(`${assetNode} has the wrong data.type: ${data?.type}`);
      }

      // No duplicates
      if (!data.assets.some(a => a.assetSelector === stackAsset.assetSelector)) {
        data.assets.push(stackAsset);
      }
    }

    const id = stackAsset.assetType === AssetType.FILE ? `FileAsset${++this._fileAssetCtr}` : `DockerAsset${++this._dockerAssetCtr}`;
    const newNode: AGraphNode = GraphNode.of(id, { type: 'publish-assets', assets: [stackAsset] });
    this.assetNodes.set(stackAsset.assetId, newNode);
    assetsGraph.add(newNode);
    newNode.dependOn(this.lastPreparationNode);
    return newNode;
  }
}

type GraphAnnotation =
  { readonly type: 'group' }
  | { readonly type: 'stack-group'; readonly stack: StackDeployment }
  | { readonly type: 'publish-assets'; readonly assets: StackAsset[] }
  | { readonly type: 'step'; readonly step: Step; isBuildStep?: boolean }
  | { readonly type: 'self-update' }
  | { readonly type: 'prepare'; readonly stack: StackDeployment }
  | { readonly type: 'execute'; readonly stack: StackDeployment }
  ;

// Type aliases for the graph nodes tagged with our specific annotation type
// (to save on generics in the code above).
export type AGraphNode = GraphNode<GraphAnnotation>;
export type AGraph = Graph<GraphAnnotation>;
