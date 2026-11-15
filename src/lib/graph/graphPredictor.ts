/**
 * Earth Trend Graph Predictive Engine — Public Facade.
 *
 * Re-exports cohesive predictor submodules from `src/lib/graph/predictor/`:
 * - `predictorTypesAndUtils`: store interface, portable inductive weights v2 loader/evaluator, quantile calibration
 * - `neighborAlignment`: multi-scale neighbor alignment, causal impulses/covariates, trust gating & lift ablation
 * - `corePredictor`: `predictFromGraph` leak-free temporal holdout Ridge/Ensemble engine
 * - `regionPredictor`: `predictRegion` arbitrary-coordinate regional forecasting
 * - `solarGraphMaterializer`: `materializeDenverSolarGraphIntoEtg` 7-node Front Range solar irradiance graph
 */

export {
  loadLocalInductiveWeightsV2,
  type EtgStoreLike,
  type PortableInductiveWeightsV2,
} from "./predictor/predictorTypesAndUtils";
export { predictFromGraph } from "./predictor/corePredictor";
export { predictRegion } from "./predictor/regionPredictor";
export { materializeDenverSolarGraphIntoEtg } from "./predictor/solarGraphMaterializer";
