import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";

export type MemoryType = "behavioral" | "factual" | "episodic";

@Entity({ name: "memory" })
export class Memory {
  @PrimaryColumn({ type: "varchar", length: 36 })
  id!: string;

  @Column({ type: "text" })
  content!: string;

  @Column({ type: "varchar", length: 32 })
  type!: MemoryType;

  @Column({ type: "simple-array", default: "" })
  tags!: string[];

  @Index({ unique: true })
  @Column({ type: "varchar", length: 64 })
  contentHash!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: "blob", nullable: true })
  embedding!: Buffer | null;
}
