import { Injectable } from "@nestjs/common";
import { WakeAction, WakeDetectedMessage } from "@vega/ear-protocol";
import { EarConnection } from "../ear.registry";

@Injectable()
export class WakeCoordinator {
  // MVP policy: every wake_detected is accepted. A future change will compare
  // scores across concurrently-listening Ears and yield all but the loudest.
  evaluate(_connection: EarConnection, _message: WakeDetectedMessage): WakeAction {
    return "proceed";
  }
}
