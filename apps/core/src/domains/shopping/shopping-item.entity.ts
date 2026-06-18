import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

export type ShoppingStatus = "pending" | "bought";

@Entity({ name: "shopping_item" })
export class ShoppingItem {
  @PrimaryColumn({ type: "varchar", length: 36 })
  id!: string;

  @Column({ type: "varchar", length: 200 })
  name!: string;

  @Column({ type: "text", nullable: true })
  note!: string | null;

  @Column({ type: "real", nullable: true })
  quantity!: number | null;

  @Column({ type: "varchar", length: 32, nullable: true })
  unit!: string | null;

  @Column({ type: "varchar", length: 16 })
  status!: ShoppingStatus;

  @Column({ type: "datetime", nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
