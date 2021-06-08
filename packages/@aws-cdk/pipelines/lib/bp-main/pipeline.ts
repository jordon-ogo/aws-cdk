import { Construct } from 'constructs';
import { AddStageOptions, AddWaveOptions, Blueprint, Step } from '../blueprint';
import { IDeploymentEngine } from './engine';

// v2 - keep this import as a separate section to reduce merge conflict when forward merging with the v2 branch.
// eslint-disable-next-line
import { Construct as CoreConstruct, Stage } from '@aws-cdk/core';

export interface PipelineProps {
  readonly synthStep: Step;
  readonly engine: IDeploymentEngine;
}

export class Pipeline extends CoreConstruct {
  private readonly blueprint: Blueprint;
  private readonly engine: IDeploymentEngine;
  private built = false;

  constructor(scope: Construct, id: string, props: PipelineProps) {
    super(scope, id);

    this.engine = props.engine;

    this.blueprint = new Blueprint({
      synthStep: props.synthStep,
    });
  }

  public addStage(stage: Stage, options?: AddStageOptions) {
    if (this.built) {
      throw new Error('addStage: can\'t add Stages anymore after build() has been called');
    }

    return this.blueprint.addStage(stage, options);
  }

  public addWave(id: string, options?: AddWaveOptions) {
    if (this.built) {
      throw new Error('addStage: can\'t add Stages anymore after build() has been called');
    }

    return this.blueprint.addWave(id, options);
  }

  public build() {
    if (this.built) {
      throw new Error('build() has already been called: can only call it once');
    }
    this.engine.buildDeployment(this.blueprint);
    this.built = true;
  }

  protected prepare() {
    if (!this.built) {
      this.build();
    }
  }
}