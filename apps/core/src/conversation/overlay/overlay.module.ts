import { Module } from "@nestjs/common";
import { OverlayService } from "./overlay.service";
import { ListViewService } from "./list-view.service";

@Module({
  providers: [OverlayService, ListViewService],
  exports: [OverlayService, ListViewService],
})
export class OverlayModule {}
